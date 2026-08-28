import { isIP } from "node:net";

/**
 * 요청을 보낸 손님을 **믿을 수 있게** 구분한다.
 *
 * server-only를 붙이지 않는다 — 순수 계산이고 단위 테스트에서 그대로 불러야
 * 한다(rate-limit.ts와 같은 이유).
 *
 * ── 왜 이 파일이 따로 필요한가 ──
 *
 * 원래 코드는 x-forwarded-for의 **첫 번째** 값을 검사 없이 썼다. 그게 왜
 * 위험한지는 Next 소스에 그대로 드러난다(base-server.js):
 *
 *     req.headers['x-forwarded-for'] ??= originalRequest.socket.remoteAddress;
 *
 * `??=` 다. 클라이언트가 보낸 XFF가 있으면 Next는 **덮어쓰지 않는다.**
 * 그리고 NextRequest에는 .ip가 없어서(타입 정의 확인) 라우트 핸들러에서
 * 진짜 소켓 주소를 되찾을 방법이 없다. 즉 공격자가 매 요청
 * `X-Forwarded-For: 1.2.3.<난수>`를 붙이면 요청마다 새 손님이 되어
 * IP별 제한을 그냥 통과한다. 감사 로그의 source_ip도 같은 이유로 위조된다.
 *
 * ── 왜 마지막 항목인가 ──
 *
 * XFF는 각 프록시가 **뒤에 덧붙인다.** 클라이언트가 `fake`를 보내면 프록시는
 * `fake, <프록시가 실제로 본 주소>`로 만들어 넘긴다. 그러므로 신뢰할 수 있는
 * 프록시가 hops개 있을 때 진짜 주소는 **뒤에서 hops번째**다.
 * 첫 항목은 언제나 클라이언트가 쓴 값이라 절대 믿으면 안 된다.
 */

/** 열쇠를 만들 수 없을 때 모두가 함께 쓰는 이름. */
export const SHARED_CLIENT_KEY = "shared";

/**
 * IPv6 대괄호와 뒤에 붙은 포트를 떼어낸다.
 *
 * 프록시 구현에 따라 `[::1]:54321`, `192.168.0.2:54321` 같은 값이 온다.
 * 포트를 그대로 두면 같은 사람이 요청마다 다른 열쇠가 되어 제한이 무력해진다.
 */
function stripPort(value: string): string {
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return close > 0 ? value.slice(1, close) : value;
  }
  // IPv6는 콜론이 여럿이라 포트와 구분되지 않는다. 콜론이 정확히 하나일
  // 때만 포트로 본다(그때는 IPv4다).
  const colon = value.indexOf(":");
  if (colon > 0 && value.indexOf(":", colon + 1) === -1) {
    return value.slice(0, colon);
  }
  return value;
}

/**
 * 신뢰할 수 있는 클라이언트 IP. 믿을 수 없으면 null.
 *
 * @param forwardedFor x-forwarded-for 헤더 원문
 * @param hops 우리 앞에 있는 **신뢰하는** 프록시 수. 0이면 XFF를 믿지 않는다.
 */
export function trustedClientIp(
  forwardedFor: string | null,
  hops: number
): string | null {
  // hops가 0이면 우리 앞에 프록시가 없다는 뜻이다. 그러면 XFF에 값이 있다는
  // 것 자체가 클라이언트가 직접 써 보냈거나 Next가 소켓 주소로 채운 것인데,
  // 둘을 구분할 방법이 없다. 구분할 수 없으면 믿지 않는다.
  if (!Number.isInteger(hops) || hops < 1) return null;
  if (!forwardedFor) return null;

  const parts = forwardedFor.split(",");
  const index = parts.length - hops;
  // 기대한 것보다 항목이 적다 = 프록시를 거치지 않고 들어왔거나 설정이
  // 틀렸다. 어느 쪽이든 그 값을 신뢰의 근거로 삼을 수 없다.
  if (index < 0 || index >= parts.length) return null;

  const candidate = stripPort(parts[index].trim());
  // 형식을 확인하지 않으면 임의의 긴 문자열이 열쇠가 되어 Map을 부풀리는
  // 도구가 된다. isIP는 IPv4·IPv6를 모두 정확히 판정한다.
  return isIP(candidate) === 0 ? null : candidate;
}

/**
 * 속도 제한에 쓸 열쇠.
 *
 * 손님을 구분할 수 없으면 **모두를 한 통에 넣는다.** IP별로 나눌 수 없다고
 * 제한을 포기하면 안 되기 때문이다 — 지금 막으려는 것은 "한 사람이 여러 번"이
 * 아니라 "제한이 없어서 서버가 녹는 것"이다. 공용 한도는 공격자가 관리자를
 * 막을 수 있다는 뜻이지만, 한도가 없으면 어차피 CPU가 녹아 관리자도 못
 * 들어오고 그때는 포털에 붙은 모든 시스템이 함께 죽는다.
 *
 * 이 상태는 6단계에서 리버스 프록시를 세우고 TRUSTED_PROXY_HOPS=1로 바꾸면
 * 끝난다.
 */
export function rateLimitKey(forwardedFor: string | null, hops: number): string {
  return trustedClientIp(forwardedFor, hops) ?? SHARED_CLIENT_KEY;
}
