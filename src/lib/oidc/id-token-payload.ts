/**
 * ID 토큰에 **무엇이 실리는지**를 정하는 순수 부분.
 *
 * 서명하는 쪽(id-token.ts)에서 떼어낸 이유: 여기 실리는 값이 하나만
 * 달라져도 붙어 있는 시스템의 로그인이 조용히 달라지는데 — 클레임 하나가
 * 빠지면 그 시스템은 "역할이 없는 사람"으로 읽는다 — 서명 쪽은 키를 읽느라
 * server-only라서 이 저장소의 테스트(순수 함수용, --conditions=react-server
 * 없이 돈다)가 부를 수 없다. lan-address.ts·transport-check.ts와 같은
 * 갈래다: 판정은 순수 함수로 두고, 바깥을 만지는 부분만 따로 뺀다.
 */
import { SERVICE_MENU_CLAIM, type ServiceMenuEntry } from "./service-menu";

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
  /**
   * 이 사람이 쓸 수 있는 서비스 목록. 각 시스템의 서비스 전환 메뉴바가 쓴다
   * (service-menu.ts).
   *
   * 권한대로 걸러진 뒤의 목록이어야 한다 — 이 파일은 거르지 않는다.
   */
  services: readonly ServiceMenuEntry[];
};

/**
 * 서명 전의 payload.
 *
 * iss·sub·aud·iat·exp는 여기서 만들지 않는다. 그것들은 SignJWT의 전용
 * 설정으로 넣어야 라이브러리가 형식을 보장한다(id-token.ts).
 */
export function buildIdTokenPayload(
  claims: IdTokenClaims
): Record<string, unknown> {
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

  /**
   * 서비스 목록은 **비어 있어도 싣는다.** email·role과 일부러 다르게 한다.
   *
   * 저 둘은 "값이 없다"와 "빈 값"을 구분해야 하는 낱값이지만, 이쪽은 목록이라
   * 빈 목록 자체가 "쓸 수 있는 서비스가 없다"는 완결된 답이다. 게다가 이
   * 클레임이 **있느냐 없느냐**가 받는 쪽에게는 "이 포털이 메뉴바를 지원하는
   * 판인가"를 가르는 표지가 된다 — 없을 때만 제 나름의 대비를 하면 된다.
   * 사람마다 나타났다 사라지면 그 판단을 할 수 없다.
   *
   * 옛 클라이언트(A/S·계측기)는 이 이름을 모르므로 그냥 지나친다. JWT는
   * 모르는 클레임을 무시하는 것이 기본이고, 이 저장소가 검증에 쓰는 jose도
   * 그렇다. 그래서 더해도 지금 붙어 있는 로그인은 그대로 돈다.
   */
  payload[SERVICE_MENU_CLAIM] = claims.services;

  return payload;
}
