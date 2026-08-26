import type { NextRequest } from "next/server";
import { secureCookiesEnabled } from "@/lib/config/env";
import { appendAuditLog } from "@/lib/db/mutations/audit";
import { createPendingUserWithIdentity, touchLastLogin } from "@/lib/db/mutations/users";
import { getUserByIdentity } from "@/lib/db/queries/users";
import { clientIp, redirectTo } from "@/lib/http/redirect";
import { exchangeKakaoCode, KakaoExchangeError } from "@/lib/kakao/client";
import { LOGIN_TX_COOKIE, verifyLoginTx } from "@/lib/session/login-tx";
import {
  createSsoSession,
  SSO_COOKIE_NAME,
  ssoCookieOptions,
} from "@/lib/session/sso-session";

/** 사용한 왕복 쿠키는 성공하든 실패하든 반드시 지운다. */
function clearLoginTx(response: ReturnType<typeof redirectTo>) {
  response.cookies.set(LOGIN_TX_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookiesEnabled(),
    path: "/api/kakao",
    maxAge: 0,
  });
  return response;
}

function fail(reason: string) {
  return clearLoginTx(redirectTo(`/signin?error=${encodeURIComponent(reason)}`));
}

/**
 * 카카오가 사용자를 돌려보내는 곳.
 *
 * 여기서 하는 일: state 대조 → 코드 교환 및 id_token 검증 → 사원 명단 대조
 * → SSO 세션 발급. 명단에 없는 사람은 거절하지 않고 **승인 대기(PENDING)로
 * 만든다** — 카카오 로그인 버튼은 누구나 누를 수 있으므로 이 행은 "권한"이
 * 아니라 "신청서"다. PENDING 상태로는 어떤 시스템에도 들어갈 수 없다.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // 사용자가 카카오 동의 화면에서 취소를 눌렀을 때.
  const kakaoError = params.get("error");
  if (kakaoError) {
    return fail(kakaoError === "access_denied" ? "cancelled" : "kakao");
  }

  const code = params.get("code");
  const state = params.get("state");
  const tx = await verifyLoginTx(request.cookies.get(LOGIN_TX_COOKIE)?.value);

  if (!tx) return fail("expired");
  // 타이밍 공격 대상이 아니다(공격자가 자기 state를 맞히는 게임이 아니라,
  // 자기 값을 심는 게임이다). 단순 비교로 충분하다.
  if (!code || !state || state !== tx.state) return fail("state");

  let profile;
  try {
    profile = await exchangeKakaoCode({
      code,
      codeVerifier: tx.codeVerifier,
      expectedNonce: tx.nonce,
    });
  } catch (error) {
    // 원인은 서버 로그에만 남긴다 — 사용자에게 내부 설정 상태를 알려주지 않는다.
    console.error(
      "[kakao] 코드 교환 실패:",
      error instanceof KakaoExchangeError ? error.message : error
    );
    return fail("kakao");
  }

  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent");

  let user = await getUserByIdentity("KAKAO", profile.subject);
  let isNewUser = false;
  if (!user) {
    user = await createPendingUserWithIdentity({
      provider: "KAKAO",
      providerSubject: profile.subject,
      displayName: profile.nickname ?? "",
    });
    isNewUser = true;
    await appendAuditLog({
      actorUserId: user.id,
      actionType: "USER_CREATED",
      targetEntity: "users",
      targetRecordId: user.id,
      newValue: { status: "PENDING", via: "KAKAO" },
      sourceIp: ip,
      userAgent,
    });
  }

  if (user.status === "SUSPENDED") {
    await appendAuditLog({
      actorUserId: user.id,
      actionType: "LOGIN_FAILED",
      newValue: { reason: "SUSPENDED" },
      sourceIp: ip,
      userAgent,
    });
    return fail("suspended");
  }

  const { token } = await createSsoSession({
    userId: user.id,
    authMethod: "KAKAO",
    userAgent,
    sourceIp: ip,
  });
  await touchLastLogin(user.id);
  await appendAuditLog({
    actorUserId: user.id,
    actionType: "LOGIN_SUCCESS",
    newValue: { method: "KAKAO", isNewUser },
    sourceIp: ip,
    userAgent,
  });

  // 승인 전에는 어디로도 못 간다. returnTo가 있어도 무시한다.
  const destination =
    user.status === "ACTIVE" ? (tx.returnTo ?? "/apps") : "/pending";

  const response = clearLoginTx(redirectTo(destination));
  response.cookies.set(SSO_COOKIE_NAME, token, ssoCookieOptions());
  return response;
}
