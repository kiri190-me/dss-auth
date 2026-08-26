import { randomBytes } from "node:crypto";

/**
 * 예측 불가능한 토큰. 세션 토큰, 인가 코드, 클라이언트 시크릿에 쓴다.
 *
 * Math.random()은 절대 쓰지 않는다 — 암호학적으로 안전하지 않아 다음 값을
 * 예측할 수 있다.
 */
export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

/**
 * PKCE code_verifier. RFC 7636 §4.1이 43~128자의 [A-Za-z0-9-._~]를 요구한다.
 * 64바이트 → base64url 86자로 그 범위 안에 들어간다.
 */
export function randomCodeVerifier(): string {
  return randomBytes(64).toString("base64url");
}
