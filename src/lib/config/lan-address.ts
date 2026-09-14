/**
 * 이 기계의 사내망 IPv4 주소를 **실행 시점에** 찾는다.
 *
 * 왜 있는가: 개발 PC도 NAS도 주소를 DHCP로 받는다. 주소가 바뀌면 통합
 * 로그인이 통째로 막히는데, 고칠 곳이 시스템마다 네 군데씩 흩어져 있어
 * (dss-deploy/README.md "주소가 바뀌면 고칠 곳") 하나만 빠뜨려도 증상은
 * "로그인이 안 된다" 하나로 뭉뚱그려진다. 원인을 좁히는 데 시간이 가장
 * 많이 드는 종류의 고장이다.
 *
 * 설정에 IP를 적지 않고 여기서 찾으면 고칠 곳이 0이 된다.
 *
 * server-only를 붙이지 않은 이유는 transport-check.ts와 같다 — 판정 규칙을
 * 테스트로 고정해야 하는데, server-only가 붙으면 이 저장소의 테스트(순수
 * 함수용, --conditions=react-server 없이 돈다)에서 부를 수 없다. 그래서
 * 판정은 전부 순수 함수로 두고, os를 실제로 읽는 함수만 따로 뺐다.
 */
import { networkInterfaces } from "node:os";

/**
 * 등록 주소에 IP 대신 적는 자리표시자. 예:
 *
 *   http://{lan}:3000/api/auth/sso/callback
 *
 * 비교 직전에 이 기계의 실제 주소로 펼쳐진 뒤, **평소와 똑같이 정확
 * 일치로만** 대조된다. 와일드카드가 아니다 — 펼쳐진 결과는 언제나 이
 * 서버 자신의 주소이고, 요청하는 쪽이 그 값에 영향을 줄 수 없다.
 * 자세한 근거는 oidc/redirect-uri.ts에 적었다.
 */
export const LAN_PLACEHOLDER = "{lan}";

/** os.networkInterfaces()가 주는 모양 중 우리가 보는 부분만. */
export type InterfaceSnapshot = Record<
  string,
  ReadonlyArray<{ address: string; family: string | number; internal: boolean }> | undefined
>;

/**
 * 가상 어댑터 이름. 이 기계에서 WSL이 172.23.224.1을 들고 있는데, 그것도
 * 사설 대역이라 주소만 봐서는 진짜 랜카드와 구별되지 않는다. 여기에 걸리면
 * 뒤로 밀 뿐 버리지는 않는다 — 이름 규칙은 환경마다 다르고, 틀렸을 때
 * "주소를 못 찾음"보다 "순서가 아쉬움"이 안전하다.
 */
const VIRTUAL_ADAPTER = /(vethernet|hyper-?v|wsl|virtualbox|vmware|docker|bluetooth|블루투스|loopback)/i;

/**
 * Windows 모바일 핫스팟. 2026-09-13 이 PC에서 포털 issuer가 핫스팟 주소
 * (192.168.137.1)로 떴다. 실제 Wi-Fi는 192.168.35.215였다. 어댑터 이름이
 * 위 규칙에 걸리지 않고, 둘 다 192.168이라 대역 순위도 같아서, 마지막
 * 사전순에서 "137"이 "35"보다 앞섰다. 이 PC 안의 왕복은 되니 check:oidc가
 * 못 잡고, 폰이나 동료 PC에서만 로그인이 막힌다.
 *
 * 표지 둘 중 하나만 맞아도 핫스팟으로 본다.
 * - 주소: Windows가 핫스팟(인터넷 연결 공유)에 기본으로 쓰는 대역이
 *   192.168.137.0/24이고 PC 자신이 .1을 갖는다.
 * - 이름: 핫스팟 어댑터는 "로컬 영역 연결* 12"(영문 "Local Area Connection* 12")
 *   처럼 별표 뒤에 번호가 붙는다. 대역을 레지스트리로 바꾼 PC도 이걸로 잡힌다.
 *   별표가 있어야 한다 — 옛 Windows는 진짜 유선 랜카드를 "Local Area
 *   Connection 2"라고 불렀다.
 *
 * 걸려도 가상 어댑터처럼 뒤로 밀 뿐 버리지 않는다. 사용자는 핫스팟을 켜고
 * 폰을 붙여 쓸 때가 있고, 그때 {lan}을 펼친 후보에 이 주소가 있어야 한다.
 */
const HOTSPOT_SUBNET = "192.168.137.";
const HOTSPOT_ADAPTER = /(연결|connection)\*\s*\d+$/i;

/**
 * 어댑터 층. 낮을수록 먼저이고, 대역 순위보다 앞서 본다 — 아이폰 핫스팟에
 * 붙은 Wi-Fi(172.20.10.x)가 이 PC 자신의 핫스팟(192.168.137.1)에 밀리면
 * 안 된다.
 *
 *   0 진짜 어댑터 → 1 핫스팟 → 2 가상 어댑터
 *
 * 핫스팟을 가상 어댑터와 한 층에 두지 않고 사이에 층을 따로 둔 이유:
 * 핫스팟은 폰이 실제로 붙는 망이지만, 가상 어댑터(VMware·VirtualBox가 잡는
 * 192.168.x.1 같은 것)는 이 PC 밖에서 아무도 닿지 않는다. 한 층에 두면
 * 둘 다 192.168일 때 사전순이 승부를 내서, 진짜 어댑터가 없을 때 대표
 * 주소가 아무도 못 닿는 쪽으로 갈 수 있다. 가상 어댑터 이름이 먼저 걸리면
 * 그쪽으로 본다 — 더 뒤로 미는 쪽이 안전하다.
 */
function adapterTier(name: string, address: string): number {
  if (VIRTUAL_ADAPTER.test(name)) return 2;
  if (address.startsWith(HOTSPOT_SUBNET) || HOTSPOT_ADAPTER.test(name)) return 1;
  return 0;
}

/** 169.254/16. 주소를 못 받았을 때 OS가 스스로 붙이는 값이라 쓸모가 없다. */
function isLinkLocal(address: string): boolean {
  return address.startsWith("169.254.");
}

/**
 * 사설 대역 선호 순위. 낮을수록 먼저다. 같은 층 안에서만 본다.
 *
 * 이름 규칙이 빗나가도 이 순위가 한 번 더 걸러준다 — 가정·사무실 공유기는
 * 거의 192.168이고, WSL·Docker가 잡는 172.16~31과 겹치지 않는다.
 */
function subnetRank(address: string): number {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3; // 공인 주소 등. 못 쓸 값은 아니므로 맨 뒤에 둔다.
}

/**
 * 쓸 만한 IPv4를 좋은 순서로 모은다. 순수 함수 — 테스트가 스냅샷을 직접
 * 만들어 넣을 수 있어야 한다.
 */
export function collectLanAddresses(snapshot: InterfaceSnapshot): string[] {
  const found: { address: string; tier: number }[] = [];

  for (const [name, entries] of Object.entries(snapshot)) {
    for (const entry of entries ?? []) {
      // Node 18과 20이 family를 "IPv4"와 4로 서로 다르게 준 적이 있다.
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      if (entry.internal) continue; // 127.0.0.1
      if (isLinkLocal(entry.address)) continue;
      found.push({ address: entry.address, tier: adapterTier(name, entry.address) });
    }
  }

  return found
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const rank = subnetRank(a.address) - subnetRank(b.address);
      if (rank !== 0) return rank;
      // 순서가 실행마다 흔들리면 issuer가 흔들린다. 마지막엔 사전순으로 못 박는다.
      return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    })
    .map((entry) => entry.address);
}

/**
 * 실제로 os를 읽는다.
 *
 * 짧게 캐시하는 이유: 요청마다 부르는 자리(redirect_uri 검증)가 있어 매번
 * 시스템 호출을 하기는 아깝고, 그렇다고 프로세스 수명 내내 붙들면 Wi-Fi를
 * 옮겼을 때 개발 서버를 다시 띄워야 한다. 5초면 둘 다 피한다 — 망을
 * 바꾸고 커피 한 모금 하는 사이에 저절로 맞는다.
 */
const DETECT_CACHE_MS = 5000;
let cache: { at: number; addresses: string[] } | null = null;

export function detectLanAddresses(now: number = Date.now()): string[] {
  if (cache && now - cache.at < DETECT_CACHE_MS) return cache.addresses;
  const addresses = collectLanAddresses(networkInterfaces() as InterfaceSnapshot);
  cache = { at: now, addresses };
  return addresses;
}

/** 테스트와 진단 명령이 캐시를 비울 수 있게 열어 둔다. */
export function resetLanAddressCache(): void {
  cache = null;
}

/**
 * 이 서버가 스스로를 부를 때 쓸 대표 주소 하나.
 *
 * 못 찾으면 조용히 127.0.0.1로 물러서지 않고 멈춘다. 그 상태로 뜨면 발급된
 * ID 토큰의 iss가 전부 localhost가 되어, 폰에서 들어온 로그인이 "성공했는데
 * 돌아오지 못하는" 가장 설명하기 어려운 모양으로 깨진다.
 */
export function primaryLanAddress(): string {
  const [first] = detectLanAddresses();
  if (!first) {
    throw new Error(
      "사내망 IPv4 주소를 찾지 못했습니다. 랜/Wi-Fi가 연결되어 있는지 확인하거나, " +
        "설정값에 auto 대신 주소를 직접 적으세요(예: OIDC_ISSUER=http://192.168.0.13:3100)."
    );
  }
  return first;
}

/**
 * 호스트 자리가 정확히 자리표시자인가.
 *
 * 문자열에 {lan}이 들어 있는지가 아니라 **호스트 자리인지**를 본다.
 * new URL()이 "http://{lan}:3000/cb"를 파싱해 hostname으로 "{lan}"을 주는
 * 것을 확인하고 이 방식을 골랐다. 경로나 쿼리에 우연히 같은 글자가 있는
 * 주소를 호스트 치환 대상으로 오해하지 않는다.
 */
export function hasLanPlaceholder(uri: string): boolean {
  try {
    return new URL(uri).hostname === LAN_PLACEHOLDER;
  } catch {
    return false;
  }
}

/**
 * 자리표시자를 이 기계의 주소들로 펼친다. 자리표시자가 없으면 원본 하나를
 * 그대로 돌려준다.
 *
 * 되짚어 만들지 않고 **문자열을 그 자리에서만 바꾸는** 이유: URL 객체로
 * 재조립하면 기본 포트 생략·경로 정규화 같은 손질이 끼어든다. 그 결과는
 * 등록값과 한 글자만 달라도 안 되는 비교에 그대로 들어간다.
 *
 * 주소를 하나도 못 찾으면 빈 배열이다 — 아무것도 통과하지 못한다.
 * 검증이 느슨해지는 쪽이 아니라 막히는 쪽으로 실패한다.
 */
export function expandLanPlaceholder(
  uri: string,
  addresses: readonly string[]
): string[] {
  if (!hasLanPlaceholder(uri)) return [uri];

  const marker = `://${LAN_PLACEHOLDER}`;
  const at = uri.indexOf(marker);
  // hasLanPlaceholder가 참이면 반드시 있다. 방어적으로 한 번 더 본다.
  if (at < 0) return [];

  const head = uri.slice(0, at + 3); // "://"까지
  const tail = uri.slice(at + marker.length);
  return addresses.map((address) => `${head}${address}${tail}`);
}

/** 목록 전체를 펼친다. 등록 주소 배열에 그대로 쓴다. */
export function expandLanPlaceholders(
  uris: readonly string[],
  addresses: readonly string[]
): string[] {
  return uris.flatMap((uri) => expandLanPlaceholder(uri, addresses));
}

/**
 * 설정값 하나를 푼다. "auto" 또는 "auto:3100"이면 이 기계 주소로 만들고,
 * 아니면 적힌 값을 그대로 쓴다.
 *
 * auto는 언제나 http다. HTTPS는 앞에 리버스 프록시가 서야 성립하는데,
 * 그 단계에서는 밖에서 보이는 이름이 IP가 아니라 도메인이므로 auto로
 * 추측할 수 있는 값이 아니다. 그때는 주소를 직접 적는 것이 맞다.
 */
export function resolveAutoUrl(
  raw: string,
  fallbackPort: number,
  address: string
): string {
  if (raw !== "auto" && !raw.startsWith("auto:")) return raw;
  const port = raw.startsWith("auto:") ? raw.slice("auto:".length) : String(fallbackPort);
  if (!/^\d+$/.test(port)) {
    throw new Error(`auto: 뒤에는 포트 번호만 올 수 있습니다(받은 값: ${raw}).`);
  }
  return `http://${address}:${port}`;
}

/**
 * 하나만 골라야 하는 자리에서 쓴다 — 사람이 눌러 들어갈 런처 링크,
 * 우리가 직접 POST하는 백채널 로그아웃 주소 같은 곳.
 *
 * 검증(redirect_uri)에는 쓰지 않는다. 거기서는 이 기계가 가진 주소를
 * 모두 후보로 두어야 하고, 못 찾았을 때 막혀야 한다. 여기는 반대다 —
 * 표시와 통보라서, 주소를 못 찾으면 원본을 그대로 돌려주어 자리표시자가
 * 눈에 보이게 둔다. 조용히 사라지는 것보다 낫다.
 */
export function expandLanPlaceholderToPrimary(uri: string): string {
  if (!hasLanPlaceholder(uri)) return uri;
  const [primary] = detectLanAddresses();
  if (!primary) return uri;
  return expandLanPlaceholder(uri, [primary])[0] ?? uri;
}
