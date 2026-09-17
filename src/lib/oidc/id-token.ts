import "server-only";
import { SignJWT } from "jose";
import { getIssuer } from "@/lib/config/env";
import { getSigningKey } from "@/lib/crypto/keys";
import { buildIdTokenPayload, type IdTokenClaims } from "./id-token-payload";

/**
 * ID 토큰 수명 5분.
 *
 * 이 토큰은 받자마자 검증되고 버려진다 — 각 시스템은 이걸로 자기 세션
 * 쿠키를 발급하고 그 다음부터는 자기 세션을 쓴다. 길게 잡을 이유가 없고,
 * 짧을수록 탈취됐을 때 쓸 수 있는 시간이 줄어든다.
 */
const ID_TOKEN_TTL_SECONDS = 300;

/**
 * 무엇이 실리는지는 id-token-payload.ts가 정한다(서명 없이 테스트할 수
 * 있어야 해서 떼어냈다). 부르는 쪽은 여기 하나만 알면 되도록 타입을 그대로
 * 다시 내보낸다.
 */
export type { IdTokenClaims };

/**
 * ID 토큰 서명.
 *
 * 헤더에 kid를 넣는 이유: 키를 교체하는 동안 JWKS에 공개키가 둘 이상
 * 노출되는데, 받는 쪽이 어느 것으로 검증할지 알아야 한다. kid가 없으면
 * 전부 시도해 보거나 실패한다.
 */
export async function signIdToken(claims: IdTokenClaims): Promise<string> {
  const { key, kid } = await getSigningKey();
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT(buildIdTokenPayload(claims))
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(getIssuer())
    .setSubject(claims.subject)
    .setAudience(claims.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + ID_TOKEN_TTL_SECONDS)
    .sign(key);
}
