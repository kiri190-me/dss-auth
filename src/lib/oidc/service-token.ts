import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

/**
 * ============================================================================
 * 포털이 **사람 대신** 각 시스템에 물으러 갈 때의 자격 — 서명 토큰
 * ============================================================================
 * 통합 종은 포털이 각 시스템에 「이 사람의 지금 알림 내놔」라고 물어 모은다
 * (NOTIFICATION_AND_IDENTITY_DESIGN.md E·F-7). 이 파일은 그 질문에 붙일
 * 자격증명을 굽는다.
 *
 * 🔴 **새로 설계하지 않았다.** 백채널 로그아웃 토큰(logout-token.ts)을 그대로
 * 따른다 — 같은 서명 키, 같은 RS256, 같은 iss, 같은 수명대. 받는 쪽도 그
 * 대칭으로 만들어져 있다(A/S 의 lib/auth/portal-service-token.ts: 「저쪽은
 * 포털이 서명한 토큰을 우리가 받아 검증하고, 이쪽도 똑같다」).
 *
 * 다른 것은 하나, **무엇을 하러 왔는가**(`purpose`)다.
 *
 * ── 받는 쪽이 요구하는 것 (A/S portal-service-token.ts 와 한 글자씩 맞췄다)
 *  1. 서명이 포털의 JWKS 로 검증될 것 → 같은 getSigningKey() 를 쓴다
 *  2. `iss` = 포털 issuer
 *  3. `aud` = **받는 시스템의 client_id**
 *  4. 🔴 `exp` 가 있을 것 — 없으면 거절된다
 *  5. 🔴 `exp − iat` ≤ 600초 — 넘으면 거절된다
 *  6. 🔴 `nonce` 가 **없을 것** — 있으면 ID 토큰으로 보고 거절된다
 *  7. 🔴 `purpose` 가 그 통로의 값과 정확히 같을 것
 *  8. `sub` 가 있을 것 — 누구의 알림인지는 **토큰 안에서만** 간다
 *
 * server-only 를 붙이지 않는다 — 위 여덟 가지는 하나만 틀려도 모든 통합 알림이
 * 조용히 401 이 되는 값이라 시험으로 못 박아야 한다. 그래서 **서명 키를 인자로
 * 받고**, 환경에서 키를 읽는 일은 부르는 쪽(notifications/service.ts)이 한다.
 * lan-address.ts·transport-check.ts 가 판정만 순수 함수로 빼 둔 것과 같은 모양이고,
 * 받는 쪽 A/S 도 같은 이유로 verifyPortalTokenWithKey 를 분리해 두었다.
 * ============================================================================
 */

/**
 * 토큰이 무엇을 하러 왔는가.
 *
 * 🔴 **통로마다 다른 값이어야 한다.** 알림을 읽으려고 구운 토큰으로 설정을
 * 고칠 수 없어야 하기 때문이다(최소 권한). 한 값으로 뭉치면 가장 약한 통로가
 * 새는 순간 가장 센 통로까지 함께 열린다.
 *
 * 🔴 이 글자들은 **A/S 의 PORTAL_TOKEN_PURPOSES 와 똑같아야 한다.** 한쪽만
 * 바꾸면 그 통로만 401 이 되고, 증상은 「알림이 안 온다」 하나로 뭉뚱그려진다.
 * 저장소가 둘이라 컴파일러가 잡아 주지 못하는 자리다 — 고칠 때는 양쪽을 함께.
 */
export const PORTAL_SERVICE_TOKEN_PURPOSES = {
  /** 「이 사람의 지금 알림」 읽기. */
  notificationsRead: "dss.notifications.read",
  /** 알림 설정 읽기. */
  notificationSettingsRead: "dss.notification-settings.read",
  /** 알림 설정 저장. */
  notificationSettingsWrite: "dss.notification-settings.write",
} as const;

export type PortalServiceTokenPurpose =
  (typeof PORTAL_SERVICE_TOKEN_PURPOSES)[keyof typeof PORTAL_SERVICE_TOKEN_PURPOSES];

/**
 * 수명 2분. 로그아웃 토큰과 같은 값이다.
 *
 * 근거도 같다 — 만들자마자 한 번 쓰고 버린다. 길게 두면 가로챈 사람이 나중에
 * 같은 질문을 다시 던져 남의 알림을 볼 수 있다.
 *
 * 🔴 받는 쪽 상한은 600초다(A/S PORTAL_TOKEN_MAX_LIFETIME_SECONDS). 그 값을
 * 여기에 그대로 쓰지 않은 것은 일부러다: 상한에 딱 맞춰 두면 저쪽이 상한을
 * 조이는 날 이쪽이 통째로 거절당한다. 2분은 그 절반도 안 되는 자리다.
 *
 * 저쪽은 시계 어긋남을 30초까지 봐준다. 2분이면 그 여유 안에서 넉넉하다.
 */
export const PORTAL_SERVICE_TOKEN_TTL_SECONDS = 120;

/** 실제로 이 값으로 서명한다. jose 가 받아 주는 열쇠면 무엇이든(시험은 직접 만든 키). */
type SigningKey = Parameters<SignJWT["sign"]>[0];

export type PortalServiceTokenInput = {
  /** 포털 issuer. ID 토큰의 iss 와 같은 값이어야 한다. */
  issuer: string;
  /** 🔴 받는 시스템의 공개 client_id. 다른 시스템에 들이밀 수 없게 만드는 값이다. */
  audience: string;
  /** 🔴 포털 users.id. ID 토큰의 sub 와 같은 값이고, 각 시스템이 이것으로 되짚는다. */
  subject: string;
  purpose: PortalServiceTokenPurpose;
  key: SigningKey;
  kid: string;
};

/**
 * 서명해서 토큰 문자열을 돌려준다.
 *
 * 🔴 **nonce 를 넣지 않는다.** 로그아웃 토큰이 규격상 nonce 를 금지하는 것과
 * 같은 이유다 — nonce 가 붙으면 ID 토큰과 구별되지 않고, 로그인 때 받은 ID
 * 토큰을 이 통로에 재사용하는 길이 열린다. 받는 쪽은 nonce 가 보이면 즉시
 * 거절한다.
 *
 * `jti` 는 로그아웃 토큰과 같은 이유로 넣는다. 지금 받는 쪽은 재사용을 막지
 * 않지만(A/S 의 그 주석: 쓴 jti 를 적어 둘 표가 없다), 막기로 한 날 포털을
 * 고치지 않아도 되게 미리 실어 둔다.
 */
export async function signPortalServiceToken(
  input: PortalServiceTokenInput,
  /** 시험이 시각을 고정할 수 있도록 받는다. 평소에는 지금. */
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  return new SignJWT({ purpose: input.purpose })
    .setProtectedHeader({ alg: "RS256", kid: input.kid })
    .setIssuer(input.issuer)
    .setSubject(input.subject)
    .setAudience(input.audience)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + PORTAL_SERVICE_TOKEN_TTL_SECONDS)
    .setJti(randomUUID())
    .sign(input.key);
}
