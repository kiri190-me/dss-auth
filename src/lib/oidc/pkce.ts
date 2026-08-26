import { createHash, timingSafeEqual } from "node:crypto";

/**
 * RFC 7636 §4.1이 정하는 code_verifier 형식: 43~128자의 [A-Za-z0-9-._~].
 *
 * 길이 하한이 43인 이유는 그보다 짧으면 무차별 대입이 현실적이 되기
 * 때문이다. 형식 검사를 건너뛰고 해시만 비교하면, 공격자가 "a" 같은
 * 짧은 verifier로 challenge를 만들어 보내는 것을 막지 못한다.
 */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function computeS256Challenge(codeVerifier: string): string {
  // ascii 인코딩은 RFC가 지정한 것이다. utf8로 바꾸면 비ASCII 입력에서
  // 다른 값이 나오는데, 위 형식 검사가 비ASCII를 이미 막으므로 실질
  // 차이는 없지만 규격을 그대로 따른다.
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/**
 * PKCE 검증. 이것이 인가 코드를 가로챈 공격자를 막는 마지막 방어선이다.
 *
 * 어떤 이유로 실패하든 false를 돌려주고 예외를 던지지 않는다.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!VERIFIER_PATTERN.test(codeVerifier)) return false;
  if (!codeChallenge) return false;

  const computed = Buffer.from(computeS256Challenge(codeVerifier));
  const expected = Buffer.from(codeChallenge);
  // timingSafeEqual은 길이가 다르면 던진다 — 먼저 확인한다.
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}
