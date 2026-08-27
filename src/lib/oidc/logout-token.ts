import "server-only";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { getIssuer } from "@/lib/config/env";
import { getSigningKey } from "@/lib/crypto/keys";

/**
 * 백채널 로그아웃 토큰 (OIDC Back-Channel Logout 1.0).
 *
 * 세션이 끊겼다는 사실을 각 시스템에 알린다. 받는 쪽은 이 토큰의 서명을
 * 우리 공개키(JWKS)로 검증하고, 그 사람의 세션을 끊는다.
 *
 * 왜 규격을 따르는가: 다른 팀이 붙일 때 표준 라이브러리로 받을 수 있어야
 * 한다. "DSS 전용 통보 형식 설명서를 읽고 직접 구현하세요"와는 협조 난이도가
 * 완전히 다르다 — 이 프로젝트가 OIDC를 직접 만들면서도 규격만은 정확히
 * 지키기로 한 이유와 같다.
 *
 * ID 토큰과 다른 점이 둘 있고, 둘 다 규격이 정한 것이다:
 *
 *  - `nonce`를 **넣지 않는다.** 규격이 금지한다. 로그인 응답이 아니므로
 *    nonce가 있으면 ID 토큰으로 오인될 수 있고, 그것을 로그인으로 받아들이는
 *    구현이 있으면 이 통보가 곧 로그인 수단이 된다.
 *  - `events`에 정해진 주소를 넣는다. 받는 쪽이 "이건 로그아웃 통보다"를
 *    이것으로 판별한다.
 */
const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

/**
 * 수명 2분.
 *
 * 짧게 잡는다 — 이 토큰은 만들자마자 한 번 보내고 버려진다. 길게 두면
 * 가로챈 사람이 나중에 같은 통보를 다시 보내 남을 로그아웃시킬 수 있다.
 * 받는 쪽이 jti로 재사용을 막아도, 그 전에 수명으로 줄여 두는 편이 낫다.
 */
const LOGOUT_TOKEN_TTL_SECONDS = 120;

export async function signLogoutToken(params: {
  /** 받는 클라이언트의 공개 client_id. */
  audience: string;
  /** 끊긴 사람(dss-auth users.id). */
  subject: string;
  /** 끊긴 SSO 세션 id. 받는 쪽이 세션 단위로 끊을 수 있으면 쓴다. */
  sessionId: string;
}): Promise<string> {
  const { key, kid } = await getSigningKey();
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    sid: params.sessionId,
    events: { [LOGOUT_EVENT]: {} },
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(getIssuer())
    .setSubject(params.subject)
    .setAudience(params.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + LOGOUT_TOKEN_TTL_SECONDS)
    // 받는 쪽이 같은 통보를 두 번 처리하지 않도록 하는 식별자.
    .setJti(randomUUID())
    .sign(key);
}
