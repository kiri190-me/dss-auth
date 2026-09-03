import { expandLanPlaceholders } from "@/lib/config/lan-address";

/**
 * redirect_uri 검증. **정확 문자열 일치만 허용한다.**
 *
 * 정규화(뒤 슬래시 제거, 소문자화, 기본 포트 생략 등)를 하지 않는 이유:
 * 정규화를 시작하는 순간 "등록값과 요청값의 정규화 결과가 우연히 겹치는"
 * 경로가 생기고, 그게 곧 열린 리다이렉터가 된다. OIDC Core §3.1.2.1도
 * 단순 문자열 비교를 요구한다.
 *
 * 이 함수가 false를 내면 **절대 리다이렉트하면 안 된다.** 신뢰할 수 없는
 * 주소로 오류를 실어 보내는 순간, 공격자가 임의 주소로 사용자를 보낼 수
 * 있는 발판(open redirector)을 우리가 제공하게 된다.
 *
 * ───────────────────────────────────────────────────────────────
 * {lan} 자리표시자에 대하여 — 이것은 와일드카드가 아니다.
 *
 * 등록값의 호스트 자리에 {lan}을 적을 수 있고, 비교 **직전에** 이 서버가
 * 스스로 찾은 자기 주소로 펼쳐진 뒤 평소와 똑같이 정확 일치로 대조된다.
 * 느슨해지는 지점이 없는 이유는 세 가지다.
 *
 *   1. 펼쳐진 값은 언제나 이 기계의 IPv4 주소다. 요청하는 쪽이 무엇을
 *      보내든 그 목록을 바꿀 수 없다 — 출처가 os.networkInterfaces()다.
 *   2. 펼친 뒤의 비교는 손대지 않았다. 여전히 candidate === requested다.
 *      접두사도, 부분 일치도, 정규화도 늘어나지 않았다.
 *   3. 주소를 하나도 못 찾으면 목록이 비어 아무것도 통과하지 못한다.
 *      느슨해지는 쪽이 아니라 막히는 쪽으로 실패한다.
 *
 * 왜 필요한가: 개발 PC도 NAS도 주소를 DHCP로 받는데, 주소가 바뀌면 등록값이
 * 전부 어긋나 로그인이 통째로 막힌다. 사람이 여러 곳을 손으로 맞추게 두면
 * 언젠가 하나를 빠뜨리고, 그때 나오는 증상은 원인을 가리키지 않는다.
 * ───────────────────────────────────────────────────────────────
 *
 * lanAddresses를 인자로 받는 이유: 이 파일을 순수하게 유지해 테스트가
 * 가짜 주소로 규칙을 고정할 수 있게 하려는 것이다. 기본값이 빈 배열이라,
 * 넘기는 것을 잊은 호출자는 {lan} 등록값이 통과하지 않는 쪽으로 실패한다.
 */
export function isRegisteredRedirectUri(
  requested: string,
  registered: readonly string[],
  allowHttp: boolean,
  lanAddresses: readonly string[] = []
): boolean {
  if (!requested) return false;
  // 프래그먼트는 서버에 전달되지도 않고, 등록값과의 비교를 흐린다.
  if (requested.includes("#")) return false;

  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return false;
  }

  // https만 허용하되, 사내망 HTTP 단계에서만 http를 연다.
  // allowHttp는 HTTPS 전환과 동시에 반드시 false로 되돌린다.
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    return false;
  }

  // 등록값의 {lan}을 이 기계의 실제 주소로 펼친다. 요청값은 손대지 않는다 —
  // 요청은 밖에서 오는 값이라 어떤 해석도 붙이면 안 된다.
  const candidates = expandLanPlaceholders(registered, lanAddresses);

  // 와일드카드도, 접두사 일치도 없다.
  return candidates.some((candidate) => candidate === requested);
}
