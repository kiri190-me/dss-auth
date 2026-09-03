/**
 * OIDC 제공자 기능 전체 점검 (브라우저 없이).
 *
 * 왜 필요한가: /authorize와 /token은 화면이 없어서 눈으로 확인할 수단이
 * 없다. 게다가 틀려도 "로그인은 되는 것처럼" 보이는 종류의 오류가 많다.
 * 이 스크립트가 정상 왕복 한 번과 **공격 시나리오 다섯 가지**를 돌려서
 * 각각이 제대로 거절되는지 확인한다.
 *
 * 실행 전 개발 서버가 떠 있어야 한다:
 *   npm run dev        (다른 터미널에서)
 *   npm run check:oidc
 *
 * 임시 클라이언트와 임시 세션을 만들고, 끝나면 지운다.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { db, pgClient } from "../src/lib/db/connection";
import {
  primaryLanAddress,
  resolveAutoUrl,
} from "../src/lib/config/lan-address";
import {
  accessTokens,
  authorizationCodes,
  clients,
  ssoSessions,
  userClientGrants,
  users,
} from "../src/lib/db/schema";

/**
 * OIDC_ISSUER 가 auto 면 여기서도 풀어야 한다. 풀지 않으면 "auto" 라는
 * 문자열이 그대로 기준 URL 이 되어 전 항목이 연결 실패로 떨어진다.
 */
const ISSUER = resolveAutoUrl(
  process.env.OIDC_ISSUER ?? "http://localhost:3100",
  3100,
  primaryLanAddress()
).replace(/\/+$/, "");
const TEST_CLIENT_ID = "__e2e-check";
/** 실제 시스템의 역할과 겹치지 않는 값을 쓴다 — 섞이면 진단이 어려워진다. */
const TEST_ROLE = "__E2E_ROLE";
const REDIRECT_URI = "http://localhost:9999/cb";
/** 호스트 자리에 자리표시자를 둔 등록 주소. 비교 직전에 이 기계 주소로 펼쳐진다. */
const LAN_REDIRECT_URI = "http://{lan}:9999/lan-cb";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 리다이렉트를 따라가지 않고 Location 헤더를 직접 본다. */
async function get(path: string, cookie?: string) {
  return fetch(`${ISSUER}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
}

async function postForm(path: string, body: Record<string, string>) {
  return fetch(`${ISSUER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

async function main() {
  console.log(`대상: ${ISSUER}\n`);

  // ── 준비: 서버가 살아 있는지 ──
  try {
    const probe = await fetch(`${ISSUER}/.well-known/openid-configuration`);
    if (!probe.ok) throw new Error(String(probe.status));
  } catch {
    console.error(
      `서버에 연결할 수 없습니다: ${ISSUER}\n다른 터미널에서 npm run dev 를 먼저 실행하세요.`
    );
    process.exitCode = 1;
    return;
  }

  // ── 준비: 임시 클라이언트 ──
  const clientSecret = randomBytes(32).toString("base64url");
  await db.delete(clients).where(eq(clients.clientId, TEST_CLIENT_ID));
  const [testClient] = await db
    .insert(clients)
    .values({
      clientId: TEST_CLIENT_ID,
      name: "E2E 점검용 (자동 생성)",
      clientSecretHash: sha256(clientSecret),
      redirectUris: [REDIRECT_URI, LAN_REDIRECT_URI],
      // 권한 부여 절차 없이 바로 통과시킨다 — 여기서 보려는 것은
      // 프로토콜이지 권한 모델이 아니다.
      requiresGrant: false,
      isActive: true,
      availableRoles: [TEST_ROLE],
    })
    .returning({ id: clients.id });

  // ── 준비: 임시 SSO 세션 ──
  const [testUser] = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(eq(users.status, "ACTIVE"))
    .limit(1);

  if (!testUser) {
    console.error("ACTIVE 상태인 사용자가 없습니다. 먼저 카카오 로그인을 하세요.");
    await db.delete(clients).where(eq(clients.id, testClient.id));
    process.exitCode = 1;
    return;
  }

  const sessionToken = randomBytes(32).toString("base64url");
  const [testSession] = await db
    .insert(ssoSessions)
    .values({
      userId: testUser.id,
      tokenHash: sha256(sessionToken),
      authMethod: "KAKAO",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    })
    .returning({ id: ssoSessions.id });
  const cookie = `dss_sso=${sessionToken}`;

  // requiresGrant가 false라 접근에는 필요 없지만, 역할은 부여 행에만 있다.
  // role 클레임이 실제로 실려 나가는지 보려면 행이 있어야 한다.
  await db.insert(userClientGrants).values({
    userId: testUser.id,
    clientId: testClient.id,
    role: TEST_ROLE,
    grantedBy: testUser.id,
  });

  console.log(`점검 사용자: ${testUser.displayName}\n`);

  try {
    // ─────────── 정상 왕복 ───────────
    console.log("정상 흐름");

    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");

    const authorizeQuery = new URLSearchParams({
      client_id: TEST_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const authorized = await get(`/api/oidc/authorize?${authorizeQuery}`, cookie);
    const location = authorized.headers.get("location") ?? "";
    check("authorize가 redirect_uri로 되돌려보낸다", location.startsWith(REDIRECT_URI), location);

    const returned = new URL(location || "http://x/");
    const code = returned.searchParams.get("code") ?? "";
    check("인가 코드가 실려 있다", code.length > 20);
    check("state가 그대로 돌아온다", returned.searchParams.get("state") === state);

    const tokenResponse = await postForm("/api/oidc/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: TEST_CLIENT_ID,
      client_secret: clientSecret,
    });
    const tokens = (await tokenResponse.json()) as Record<string, string>;
    check("토큰 교환 성공", tokenResponse.ok, JSON.stringify(tokens));
    check("no-store 헤더가 붙는다", tokenResponse.headers.get("cache-control") === "no-store");
    check("id_token이 있다", typeof tokens.id_token === "string");
    check("access_token이 있다", typeof tokens.access_token === "string");

    // ── ID 토큰을 공개키로 실제 검증한다 ──
    const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
    let claims: Record<string, unknown> = {};
    try {
      const verified = await jwtVerify(tokens.id_token, jwks, {
        issuer: ISSUER,
        audience: TEST_CLIENT_ID,
      });
      claims = verified.payload as Record<string, unknown>;
      check("ID 토큰 서명이 JWKS 공개키로 검증된다", true);
    } catch (error) {
      check("ID 토큰 서명이 JWKS 공개키로 검증된다", false, String(error));
    }
    check("sub가 사용자 id와 같다", claims.sub === testUser.id);
    check("nonce가 요청한 값과 같다", claims.nonce === nonce);
    check("auth_time이 들어 있다", typeof claims.auth_time === "number");
    check("sid(세션 id)가 들어 있다", claims.sid === testSession.id);
    check(
      "role이 그 시스템에서 부여받은 역할과 같다",
      claims.role === TEST_ROLE,
      String(claims.role)
    );

    const userinfo = await fetch(`${ISSUER}/api/oidc/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = (await userinfo.json()) as Record<string, unknown>;
    check("userinfo가 응답한다", userinfo.ok);
    check("userinfo의 sub가 ID 토큰과 같다", profile.sub === claims.sub);

    // ─────────── 공격 시나리오 ───────────
    console.log("\n거절되어야 하는 것들");

    // 1) 같은 코드를 두 번 쓴다
    const replay = await postForm("/api/oidc/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: TEST_CLIENT_ID,
      client_secret: clientSecret,
    });
    const replayBody = (await replay.json()) as Record<string, string>;
    check("코드 재사용을 invalid_grant로 거절", replayBody.error === "invalid_grant");

    // 재사용 탐지가 실제로 토큰을 죽였는지 — 아까 받은 access_token이 무효여야 한다
    const afterReplay = await fetch(`${ISSUER}/api/oidc/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    check("재사용 탐지가 기존 액세스 토큰을 폐기한다", afterReplay.status === 401);

    // 2) 새 코드를 받아 잘못된 verifier로 교환
    async function freshCode() {
      const v = randomBytes(64).toString("base64url");
      const c = createHash("sha256").update(v, "ascii").digest("base64url");
      const query = new URLSearchParams({
        client_id: TEST_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "openid",
        state: randomBytes(32).toString("base64url"),
        nonce: randomBytes(32).toString("base64url"),
        code_challenge: c,
        code_challenge_method: "S256",
      });
      const response = await get(`/api/oidc/authorize?${query}`, cookie);
      const url = new URL(response.headers.get("location") ?? "http://x/");
      return { code: url.searchParams.get("code") ?? "", verifier: v };
    }

    const wrongVerifier = await freshCode();
    const badPkce = await postForm("/api/oidc/token", {
      grant_type: "authorization_code",
      code: wrongVerifier.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: randomBytes(64).toString("base64url"),
      client_id: TEST_CLIENT_ID,
      client_secret: clientSecret,
    });
    check(
      "틀린 code_verifier를 거절 (PKCE)",
      ((await badPkce.json()) as Record<string, string>).error === "invalid_grant"
    );

    // 3) redirect_uri를 한 글자 바꿔서 교환
    const wrongRedirect = await freshCode();
    const badRedirect = await postForm("/api/oidc/token", {
      grant_type: "authorization_code",
      code: wrongRedirect.code,
      redirect_uri: `${REDIRECT_URI}/`,
      code_verifier: wrongRedirect.verifier,
      client_id: TEST_CLIENT_ID,
      client_secret: clientSecret,
    });
    check(
      "redirect_uri가 한 글자만 달라도 거절",
      ((await badRedirect.json()) as Record<string, string>).error === "invalid_grant"
    );

    // 4) 시크릿을 틀리게
    const wrongSecret = await freshCode();
    const badSecret = await postForm("/api/oidc/token", {
      grant_type: "authorization_code",
      code: wrongSecret.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: wrongSecret.verifier,
      client_id: TEST_CLIENT_ID,
      client_secret: "틀린-시크릿",
    });
    check("틀린 client_secret을 401로 거절", badSecret.status === 401);

    // 5) 등록되지 않은 redirect_uri로 인가 요청 → 절대 리다이렉트하면 안 된다
    const openRedirect = await get(
      `/api/oidc/authorize?${new URLSearchParams({
        client_id: TEST_CLIENT_ID,
        redirect_uri: "https://evil.example/steal",
        response_type: "code",
        scope: "openid",
        state: "s".repeat(43),
        nonce: "n".repeat(43),
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
      })}`,
      cookie
    );
    const openRedirectTarget = openRedirect.headers.get("location") ?? "";
    check(
      "등록되지 않은 redirect_uri로는 절대 리다이렉트하지 않는다",
      !openRedirectTarget.includes("evil.example"),
      openRedirectTarget
    );
    check(
      "대신 우리 오류 화면으로 보낸다",
      openRedirectTarget.startsWith("/oauth-error"),
      openRedirectTarget
    );

    // 6) 로그인하지 않은 상태 + prompt=none
    const promptNone = await get(
      `/api/oidc/authorize?${new URLSearchParams({
        client_id: TEST_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "openid",
        state: "s".repeat(43),
        nonce: "n".repeat(43),
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
        prompt: "none",
      })}`
      // 쿠키 없음 = 미로그인
    );
    const promptNoneTarget = promptNone.headers.get("location") ?? "";
    check(
      "미로그인 + prompt=none은 login_required로 되돌려보낸다",
      promptNoneTarget.includes("error=login_required"),
      promptNoneTarget
    );

    // ─────────── {lan} 자리표시자 ───────────
    //
    // 여기서 보려는 것은 "편해졌다"가 아니라 **느슨해지지 않았다**이다.
    console.log("\n{lan} 자리표시자");

    const lanAddress = primaryLanAddress();
    const lanExpanded = `http://${lanAddress}:9999/lan-cb`;

    async function authorizeWith(redirectUri: string) {
      const response = await get(
        `/api/oidc/authorize?${new URLSearchParams({
          client_id: TEST_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "openid",
          state: "s".repeat(43),
          nonce: "n".repeat(43),
          code_challenge: "x".repeat(43),
          code_challenge_method: "S256",
        })}`,
        cookie
      );
      return response.headers.get("location") ?? "";
    }

    const lanOk = await authorizeWith(lanExpanded);
    check(
      `{lan}이 이 기계의 주소(${lanAddress})로 펼쳐져 통과한다`,
      lanOk.startsWith(lanExpanded),
      lanOk
    );

    // 같은 망의 이웃 주소. 접두사 일치나 와일드카드였다면 통과했을 값이다.
    const octets = lanAddress.split(".");
    octets[3] = octets[3] === "254" ? "253" : "254";
    const neighbour = octets.join(".");
    const lanBad = await authorizeWith(`http://${neighbour}:9999/lan-cb`);
    check(
      `같은 망의 다른 주소(${neighbour})는 거절 — 와일드카드가 아니다`,
      !lanBad.includes(neighbour) && lanBad.startsWith("/oauth-error"),
      lanBad
    );

    // 자리표시자 자체를 요청해도 통과하면 안 된다 — 요청값은 펼치지 않는다.
    const lanLiteral = await authorizeWith(LAN_REDIRECT_URI);
    check(
      "자리표시자를 그대로 요청하면 거절",
      lanLiteral.startsWith("/oauth-error"),
      lanLiteral
    );
  } finally {
    // ── 정리 ──
    await db.delete(authorizationCodes).where(eq(authorizationCodes.clientId, testClient.id));
    await db.delete(accessTokens).where(eq(accessTokens.clientId, testClient.id));
    // 부여 행이 clients를 onDelete restrict로 참조한다 — 먼저 지워야 한다.
    await db.delete(userClientGrants).where(eq(userClientGrants.clientId, testClient.id));
    await db.delete(clients).where(eq(clients.id, testClient.id));
    await db.delete(ssoSessions).where(eq(ssoSessions.id, testSession.id));
  }

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
