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
 */
export function isRegisteredRedirectUri(
  requested: string,
  registered: readonly string[],
  allowHttp: boolean
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

  // 와일드카드도, 접두사 일치도 없다.
  return registered.some((candidate) => candidate === requested);
}
