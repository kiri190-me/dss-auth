import "server-only";
import { jwtVerify, SignJWT } from "jose";
import { getAuthTxSecret } from "@/lib/config/env";

/**
 * 카카오 로그인 왕복(우리 → 카카오 → 우리) 동안 state/nonce/code_verifier를
 * 나르는 짧은 수명 쿠키.
 *
 * 왜 쿠키인가: 이 값들을 DB 테이블에 넣으면 로그인 시도마다 행이 쌓이고
 * 청소 잡이 하나 더 필요해진다. 서명된 쿠키면 브라우저가 대신 들고 있어준다.
 *
 * 왜 서명하는가: 서명이 없으면 사용자가 code_verifier를 마음대로 바꿔
 * PKCE 검증을 무력화할 수 있다.
 */
export const LOGIN_TX_COOKIE = "dss_login_tx";

/** 10분. 카카오 로그인 화면에서 머뭇거려도 충분하고, 방치된 값은 곧 죽는다. */
export const LOGIN_TX_MAX_AGE_SECONDS = 600;

export type LoginTx = {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** 로그인 후 돌아갈 곳. 오픈 리다이렉트를 막으려 경로만 허용한다. */
  returnTo: string | null;
};

function secretKey(): Uint8Array {
  return new TextEncoder().encode(getAuthTxSecret());
}

export async function signLoginTx(tx: LoginTx): Promise<string> {
  return new SignJWT({ ...tx })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${LOGIN_TX_MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

/** 서명·만료·구조 중 하나라도 어긋나면 null. 예외를 밖으로 내보내지 않는다. */
export async function verifyLoginTx(token: string | undefined): Promise<LoginTx | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { clockTolerance: 30 });
    if (
      typeof payload.state !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.codeVerifier !== "string"
    ) {
      return null;
    }
    const returnTo = typeof payload.returnTo === "string" ? payload.returnTo : null;
    return {
      state: payload.state,
      nonce: payload.nonce,
      codeVerifier: payload.codeVerifier,
      returnTo,
    };
  } catch {
    return null;
  }
}

/**
 * 로그인 후 돌아갈 주소를 안전하게 다듬는다.
 *
 * "/"로 시작하고 "//"로 시작하지 않는 경로만 허용한다. 이 검사가 없으면
 * ?returnTo=https://악성사이트 로 사용자를 보낼 수 있는 오픈 리다이렉터가 된다.
 * "//evil.com"은 브라우저가 프로토콜 상대 URL로 해석하므로 반드시 함께 막는다.
 */
export function sanitizeReturnTo(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  return raw;
}
