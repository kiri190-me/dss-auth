import type { JWK } from "jose";

/**
 * RSA 공개 JWK에서 밖으로 내보내도 되는 필드.
 *
 * 이 모듈이 keys.ts에서 분리되어 있는 이유는 테스트 때문이다. keys.ts는
 * server-only + 파일시스템 + 환경변수에 얽혀 있어 단위 테스트가 어려운데,
 * 이 판정은 틀리면 **개인키가 인터넷에 공개되는** 종류라 반드시 테스트로
 * 묶여 있어야 한다.
 */
const PUBLIC_JWK_FIELDS = ["kty", "n", "e", "kid", "alg", "use"] as const;

/**
 * 공개해도 되는 필드만 남긴다.
 *
 * 개인키 필드(d, p, q, dp, dq, qi)를 지우는 방식이 아니라 공개 필드만
 * 남기는 방식이다. 빼는 방식은 목록에 없는 새 필드가 생기면 그대로
 * 새어 나가지만, 남기는 방식은 모르는 필드를 기본적으로 버린다.
 */
export function toPublicJwk(jwk: JWK): JWK {
  const safe: Record<string, unknown> = {};
  for (const field of PUBLIC_JWK_FIELDS) {
    if (jwk[field] !== undefined) safe[field] = jwk[field];
  }
  return safe as JWK;
}
