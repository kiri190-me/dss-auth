import "server-only";
import { SignJWT } from "jose";
import { getIssuer } from "@/lib/config/env";
import { getSigningKey } from "@/lib/crypto/keys";

/**
 * ID 토큰 수명 5분.
 *
 * 이 토큰은 받자마자 검증되고 버려진다 — 각 시스템은 이걸로 자기 세션
 * 쿠키를 발급하고 그 다음부터는 자기 세션을 쓴다. 길게 잡을 이유가 없고,
 * 짧을수록 탈취됐을 때 쓸 수 있는 시간이 줄어든다.
 */
const ID_TOKEN_TTL_SECONDS = 300;

export type IdTokenClaims = {
  /** dss-auth의 users.id. 각 시스템이 사용자를 잇는 유일한 기준이다. */
  subject: string;
  /** 받는 클라이언트의 공개 client_id. */
  audience: string;
  nonce: string;
  /** SSO 세션 id. 지금은 쓰지 않지만 나중에 백채널 로그아웃을 붙일 때 필요하다. */
  sessionId: string;
  /** 실제로 사용자가 인증한 시각(코드 발급 시각이 아니다). */
  authTime: Date;
  name: string;
  email: string | null;
  /**
   * 이 사용자가 **받는 그 시스템에서** 갖는 역할(user_client_grants.role).
   *
   * 시스템마다 다르므로 audience가 정해진 이 토큰에만 실린다. 역할을 쓰지
   * 않는 시스템이거나 아직 지정되지 않았으면 null이고, 그때는 클레임 자체를
   * 싣지 않는다 — 받는 쪽에서 "안 왔다"와 "빈 값이 왔다"를 구분할 수 있어야
   * 한다.
   */
  role: string | null;
};

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

  const payload: Record<string, unknown> = {
    nonce: claims.nonce,
    sid: claims.sessionId,
    auth_time: Math.floor(claims.authTime.getTime() / 1000),
    name: claims.name,
    preferred_username: claims.name,
  };
  // 없는 값을 null로 넣지 않는다. 클레임이 없는 것과 null인 것은 다르고,
  // 일부 클라이언트는 null을 유효한 이메일로 다룬다.
  if (claims.email) {
    payload.email = claims.email;
    // 우리는 이메일 소유를 확인하지 않는다(관리자가 손으로 입력한 값이다).
    // 정직하게 false로 둔다 — true로 두면 받는 쪽이 이메일을 신원 판단에
    // 쓸 수 있다고 오해한다.
    payload.email_verified = false;
  }
  // 역할도 같은 이유로 있을 때만 넣는다.
  if (claims.role) {
    payload.role = claims.role;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(getIssuer())
    .setSubject(claims.subject)
    .setAudience(claims.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + ID_TOKEN_TTL_SECONDS)
    .sign(key);
}
