import { NextResponse } from "next/server";
import { appendAuditLog } from "@/lib/db/mutations/audit";
import {
  getActiveClient,
  verifyClientSecret,
  type ClientRecord,
} from "@/lib/db/queries/oidc-clients";
import { getUserById } from "@/lib/db/queries/users";
import { clientIp } from "@/lib/http/redirect";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  issueAccessToken,
  revokeAccessTokensFor,
} from "@/lib/oidc/access-token";
import {
  consumeAuthorizationCode,
  wasCodeAlreadyConsumed,
} from "@/lib/oidc/authorization-code";
import type { OidcErrorCode } from "@/lib/oidc/errors";
import { signIdToken } from "@/lib/oidc/id-token";
import { verifyPkceS256 } from "@/lib/oidc/pkce";

/**
 * 토큰 응답에는 반드시 no-store를 붙인다(RFC 6749 §5.1).
 * 프록시나 브라우저가 자격증명을 캐시에 남기면 안 된다.
 */
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function fail(error: OidcErrorCode, description: string, status = 400) {
  return NextResponse.json(
    { error, error_description: description },
    {
      status,
      headers:
        // 401에는 규격상 WWW-Authenticate가 있어야 한다.
        status === 401
          ? { ...NO_STORE, "www-authenticate": 'Basic realm="dss-auth"' }
          : NO_STORE,
    }
  );
}

/**
 * 클라이언트 인증. Basic 헤더와 본문 필드 두 방식을 모두 받는다
 * (discovery에 둘 다 선언했다).
 *
 * RFC 6749 §2.3.1에 따라 Basic의 각 조각은 form-urlencode된 상태이므로
 * 디코드해야 한다.
 */
function readClientCredentials(
  request: Request,
  form: FormData
): { clientId: string; clientSecret: string } | null {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    } catch {
      return null;
    }
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    try {
      return {
        clientId: decodeURIComponent(decoded.slice(0, separator)),
        clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
      };
    } catch {
      return null;
    }
  }

  const clientId = form.get("client_id");
  const clientSecret = form.get("client_secret");
  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    return null;
  }
  return { clientId, clientSecret };
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("invalid_request", "요청 본문을 읽을 수 없습니다.");
  }

  if (form.get("grant_type") !== "authorization_code") {
    return fail(
      "unsupported_grant_type",
      "authorization_code만 지원합니다."
    );
  }

  // ───── 클라이언트 인증 ─────

  const credentials = readClientCredentials(request, form);
  if (!credentials) {
    return fail("invalid_client", "클라이언트 인증 정보가 없습니다.", 401);
  }

  const client: ClientRecord | null = await getActiveClient(credentials.clientId);
  // 없는 클라이언트와 시크릿이 틀린 클라이언트를 구분해 알려주지 않는다.
  // 구분해 주면 등록된 client_id 목록을 알아내는 조회 도구가 된다.
  if (!client || !verifyClientSecret(client, credentials.clientSecret)) {
    return fail("invalid_client", "클라이언트 인증에 실패했습니다.", 401);
  }

  const code = form.get("code");
  if (typeof code !== "string" || !code) {
    return fail("invalid_request", "code가 필요합니다.");
  }

  // ───── 코드 소비 (원자적) ─────

  const consumed = await consumeAuthorizationCode(code);

  if (!consumed) {
    // 실패가 "이미 쓴 코드를 다시 들이민 것"인지 확인한다.
    // 정상 클라이언트는 코드를 한 번만 쓴다. 두 번 오는 것은 코드가
    // 유출됐다는 신호이므로, 그 코드로 발급된 토큰을 전부 죽인다.
    const replayed = await wasCodeAlreadyConsumed(code);
    if (replayed) {
      const revokedCount = await revokeAccessTokensFor(
        replayed.userId,
        replayed.clientId
      );
      await appendAuditLog({
        actorUserId: replayed.userId,
        actionType: "CODE_REPLAY_DETECTED",
        clientId: client.clientId,
        newValue: { revokedAccessTokens: revokedCount },
        sourceIp: clientIp(request),
        userAgent: request.headers.get("user-agent"),
      });
    }
    return fail("invalid_grant", "코드가 유효하지 않습니다.");
  }

  // ───── 코드가 이 클라이언트의 것인가 ─────

  if (consumed.clientId !== client.id) {
    // 다른 클라이언트에게 발급된 코드를 가로채 자기 시크릿으로 교환하려는
    // 시도다. 코드는 이미 소비 처리되었으므로 재시도해도 소용없다.
    await appendAuditLog({
      actorUserId: consumed.userId,
      actionType: "CODE_REPLAY_DETECTED",
      clientId: client.clientId,
      newValue: { reason: "CLIENT_MISMATCH" },
      sourceIp: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    return fail("invalid_grant", "코드가 유효하지 않습니다.");
  }

  // ───── redirect_uri 정확 일치 ─────

  // 인가 요청 때 쓴 값과 토큰 요청의 값이 같아야 한다. 정규화하지 않고
  // 문자 그대로 비교한다.
  if (form.get("redirect_uri") !== consumed.redirectUri) {
    return fail("invalid_grant", "redirect_uri가 일치하지 않습니다.");
  }

  // ───── PKCE ─────

  const codeVerifier = form.get("code_verifier");
  if (
    typeof codeVerifier !== "string" ||
    !verifyPkceS256(codeVerifier, consumed.codeChallenge)
  ) {
    return fail("invalid_grant", "code_verifier가 일치하지 않습니다.");
  }

  // ───── 사용자 상태 재확인 ─────

  // 인가 코드를 받은 뒤 정지됐을 수 있다. 60초짜리 창이지만, 확인 비용이
  // 조회 한 번이라 안 할 이유가 없다.
  const user = await getUserById(consumed.userId);
  if (!user || user.status !== "ACTIVE") {
    return fail("invalid_grant", "사용할 수 없는 계정입니다.");
  }

  // ───── 발급 ─────

  const idToken = await signIdToken({
    subject: user.id,
    audience: client.clientId,
    nonce: consumed.nonce,
    sessionId: consumed.ssoSessionId,
    authTime: consumed.authTime,
    name: user.displayName,
    email: user.email,
  });

  const accessToken = await issueAccessToken({
    userId: user.id,
    clientId: client.id,
    scope: consumed.scope,
  });

  await appendAuditLog({
    actorUserId: user.id,
    actionType: "TOKEN_ISSUED",
    clientId: client.clientId,
    newValue: { scope: consumed.scope },
    sourceIp: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      id_token: idToken,
      scope: consumed.scope,
    },
    { headers: NO_STORE }
  );
}
