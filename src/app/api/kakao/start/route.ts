import type { NextRequest } from "next/server";
import { buildKakaoAuthorizeUrl } from "@/lib/kakao/client";
import { secureCookiesEnabled } from "@/lib/config/env";
import { randomCodeVerifier, randomToken } from "@/lib/crypto/random";
import { redirectTo } from "@/lib/http/redirect";
import {
  LOGIN_TX_COOKIE,
  LOGIN_TX_MAX_AGE_SECONDS,
  sanitizeReturnTo,
  signLoginTx,
} from "@/lib/session/login-tx";

/**
 * 카카오 로그인 시작.
 *
 * state / nonce / code_verifier 세 값을 만들어 서명 쿠키에 담아두고 카카오로
 * 보낸다. 각각이 막는 것이 다르다:
 *   state         — 로그인 CSRF (남이 내 브라우저를 자기 계정으로 로그인시키는 것)
 *   nonce         — id_token 재사용 (예전에 받은 토큰을 다시 들이미는 것)
 *   code_verifier — 인가 코드 탈취 (코드를 가로채도 verifier 없이는 못 씀)
 */
export async function GET(request: NextRequest) {
  const state = randomToken(32);
  const nonce = randomToken(32);
  const codeVerifier = randomCodeVerifier();
  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get("returnTo"));

  const tx = await signLoginTx({ state, nonce, codeVerifier, returnTo });

  const response = redirectTo(buildKakaoAuthorizeUrl({ state, nonce, codeVerifier }), 302);
  response.cookies.set(LOGIN_TX_COOKIE, tx, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookiesEnabled(),
    // 콜백 라우트에서만 필요한 값이라 경로를 좁힌다.
    path: "/api/kakao",
    maxAge: LOGIN_TX_MAX_AGE_SECONDS,
  });
  return response;
}
