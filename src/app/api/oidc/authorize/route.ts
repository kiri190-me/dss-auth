import type { NextRequest } from "next/server";
import { allowHttpRedirectUris } from "@/lib/config/env";
import { appendAuditLog } from "@/lib/db/mutations/audit";
import {
  getActiveClient,
  hasClientAccess,
  type ClientRecord,
} from "@/lib/db/queries/oidc-clients";
import {
  authorizeEndpointLimiter,
  keyForRequest,
} from "@/lib/http/rate-limits";
import { clientIp, redirectTo } from "@/lib/http/redirect";
import { parseAuthorizeParams } from "@/lib/oidc/authorize-params";
import { issueAuthorizationCode } from "@/lib/oidc/authorization-code";
import type { OidcFailure } from "@/lib/oidc/errors";
import { detectLanAddresses } from "@/lib/config/lan-address";
import { isRegisteredRedirectUri } from "@/lib/oidc/redirect-uri";
import { readSsoSession } from "@/lib/session/sso-session";

/**
 * 신뢰할 수 있는 redirect_uri로 오류를 실어 보낸다.
 *
 * state를 그대로 되돌려주는 것은 규격이다 — 클라이언트가 자기가 보낸
 * 요청에 대한 응답인지 확인하는 근거다.
 */
function redirectWithError(
  redirectUri: string,
  failure: OidcFailure,
  state: string
) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", failure.error);
  url.searchParams.set("error_description", failure.description);
  if (state) url.searchParams.set("state", state);
  return redirectTo(url.href, 302);
}

/**
 * 인가 엔드포인트.
 *
 * ⚠️ 검사 순서가 보안의 핵심이다.
 *
 * [A] client_id와 redirect_uri를 **가장 먼저** 확인한다. 여기서 실패하면
 *     절대 리다이렉트하지 않고 우리 오류 화면으로 보낸다. 신뢰할 수 없는
 *     주소로 오류를 실어 보내는 순간, 공격자가 임의 주소를 redirect_uri에
 *     넣고 사용자를 그리로 보낼 수 있는 발판(open redirector)을 우리가
 *     제공하게 된다. 피싱에 그대로 쓰인다.
 *
 * [B] 그 다음부터의 오류는 규격대로 redirect_uri에 실어 보낸다.
 *
 * [C] 인증·인가는 마지막이다.
 */
export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;

  // ───── [0] 속도 제한 ─────
  //
  // 검사 순서의 맨 앞이다. 아래 [A]부터는 요청마다 DB를 여러 번 읽는다.
  //
  // 거절을 redirect_uri로 실어 보내지 않고 우리 화면에서 끝내는 이유는
  // 아래 [A]와 같다 — 이 시점에는 redirect_uri를 아직 검증하지 않았으므로
  // 그리로 보내면 그 자체가 열린 리다이렉터가 된다. 검증보다 먼저 걸어야
  // 하는 제한이라, 이 순서는 바꿀 수 없다.
  const limit = authorizeEndpointLimiter.check(keyForRequest(request), Date.now());
  if (!limit.allowed) {
    return redirectTo("/oauth-error?code=too_many");
  }

  // ───── [A] redirect_uri를 믿을 수 있는가 (리다이렉트 금지 구간) ─────

  const client: ClientRecord | null = await getActiveClient(
    query.get("client_id") ?? ""
  );
  if (!client) {
    return redirectTo("/oauth-error?code=unknown_client");
  }

  const redirectUri = query.get("redirect_uri") ?? "";
  if (
    !isRegisteredRedirectUri(
      redirectUri,
      client.redirectUris,
      allowHttpRedirectUris(),
      detectLanAddresses()
    )
  ) {
    return redirectTo("/oauth-error?code=bad_redirect_uri");
  }

  // ───── [B] 나머지 파라미터 (여기부터 redirect_uri로 오류 전달) ─────

  const state = query.get("state") ?? "";
  const parsed = parseAuthorizeParams(query);
  if (!parsed.ok) {
    return redirectWithError(redirectUri, parsed.failure, state);
  }
  const { scope, nonce, codeChallenge, prompt } = parsed.params;

  // ───── [C] 인증 ─────

  const session = await readSsoSession();

  if (!session || prompt === "login") {
    // prompt=none은 "화면을 절대 띄우지 말라"는 뜻이다. 세션 갱신을
    // 조용히 시도하는 용도라, 로그인 화면을 띄우면 안 되고 규격이 정한
    // 오류로 답해야 한다.
    if (prompt === "none") {
      return redirectWithError(
        redirectUri,
        { error: "login_required", description: "로그인이 필요합니다." },
        state
      );
    }

    // 로그인 후 이 요청을 그대로 다시 태운다. 파라미터를 어디에도
    // 저장하지 않고 주소에 담아 보내므로 별도 정리가 필요 없다.
    const returnTo = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    const force = prompt === "login" ? "&force=1" : "";
    return redirectTo(
      `/signin?returnTo=${encodeURIComponent(returnTo)}${force}`
    );
  }

  // 승인 대기 상태는 redirect_uri로 돌려보내지 않는다. 클라이언트가 받아봐야
  // 할 수 있는 게 없고, 사용자는 "왜 안 되는지"를 알아야 하기 때문이다.
  if (session.status === "PENDING") {
    return redirectTo("/pending");
  }

  if (session.status !== "ACTIVE") {
    await appendAuditLog({
      actorUserId: session.userId,
      actionType: "LOGIN_FAILED",
      clientId: client.clientId,
      newValue: { reason: "NOT_ACTIVE", status: session.status },
      sourceIp: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    return redirectWithError(
      redirectUri,
      { error: "access_denied", description: "사용할 수 없는 계정입니다." },
      state
    );
  }

  // ───── [C-2] 이 시스템에 들어갈 권한이 있는가 ─────

  if (!(await hasClientAccess(session.userId, client))) {
    // 이것도 우리 화면에서 안내한다. 사용자에게는 "관리자에게 문의"라는
    // 다음 행동이 있는데, 클라이언트로 돌려보내면 그 안내를 각 팀이
    // 저마다 다르게 만들어야 한다.
    return redirectTo(
      `/no-access?client=${encodeURIComponent(client.clientId)}`
    );
  }

  // ───── [D] 인가 코드 발급 ─────

  const code = await issueAuthorizationCode({
    clientId: client.id,
    userId: session.userId,
    ssoSessionId: session.sessionId,
    // 토큰 교환 때 이 값과 문자 단위로 비교한다.
    redirectUri,
    scope,
    nonce,
    codeChallenge,
    authTime: session.authTime,
  });

  const destination = new URL(redirectUri);
  destination.searchParams.set("code", code);
  if (state) destination.searchParams.set("state", state);
  return redirectTo(destination.href, 302);
}
