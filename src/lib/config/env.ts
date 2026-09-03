import "server-only";
import { checkTransportConfig } from "./transport-check";
import { primaryLanAddress, resolveAutoUrl } from "./lan-address";

/**
 * 환경변수 읽기.
 *
 * 모듈 최상위에서 값을 읽지 않고 전부 함수로 감싼 이유: `next build`는 실제
 * 환경변수 없이도 돌아야 하는데, 최상위에서 검증하면 빌드가 통째로 실패한다.
 * 함수로 두면 그 값이 실제로 필요한 요청이 들어왔을 때만 확인한다.
 *
 * 값이 없으면 조용히 기본값으로 넘어가지 않고 **명확히 throw**한다.
 * 인증 서버에서 "설정이 빠졌는데 그럭저럭 동작하는" 상태가 가장 위험하다.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name}이(가) 설정되지 않았습니다. .env.local을 확인하세요(.env.example 참고).`
    );
  }
  return value;
}

/** 이 서버의 기본 포트. package.json의 dev·start 스크립트와 같아야 한다. */
const DEFAULT_PORT = 3100;

function isAutoValue(raw: string): boolean {
  return raw === "auto" || raw.startsWith("auto:");
}

/**
 * 이 서버가 스스로를 부르는 주소. ID 토큰의 iss 클레임과 discovery 문서에
 * 그대로 들어가고, 각 시스템이 이 값을 대조한다.
 *
 * 끝의 슬래시를 제거한다 — "http://x/" 와 "http://x" 가 섞이면 iss 대조가
 * 실패하는데, 원인을 찾기가 매우 어려운 종류의 버그다.
 *
 * **auto**로 적으면 이 기계의 사내망 IPv4를 실행 시점에 찾아 쓴다
 * (lan-address.ts). 개발 PC는 Wi-Fi를 옮길 때마다 주소가 바뀌는데, 그때마다
 * 사람이 여기를 고치게 두면 언젠가 빠뜨린다. 앞에 리버스 프록시를 세워
 * 도메인으로 서비스하는 단계에서는 auto가 아니라 그 도메인을 적는다 —
 * 밖에서 보이는 이름은 이 기계가 알아낼 수 있는 값이 아니다.
 */
// 주소를 직접 적은 경우에만 캐시한다. 요청마다 다시 검사할 이유가 없다.
let issuerCache: string | null = null;

export function getIssuer(): string {
  const raw = required("OIDC_ISSUER");
  const auto = isAutoValue(raw);

  // auto는 캐시하지 않는다. 캐시하면 Wi-Fi를 옮겼을 때 개발 서버를 다시
  // 띄워야 한다. 주소 탐색 자체는 lan-address.ts가 5초 캐시로 받쳐 준다.
  if (!auto && issuerCache !== null) return issuerCache;

  const issuer = (
    auto ? resolveAutoUrl(raw, DEFAULT_PORT, primaryLanAddress()) : raw
  ).replace(/\/+$/, "");

  // 전송 설정이 서로 모순되면 여기서 멈춘다. 판정 규칙과 그 근거는
  // transport-check.ts에 있다(테스트로 고정하기 위해 분리했다).
  const problem = checkTransportConfig({
    issuer,
    httpRedirectUrisAllowed: process.env.OIDC_ALLOW_HTTP_REDIRECT_URIS === "true",
    isProduction: process.env.NODE_ENV === "production",
  });
  if (problem) throw new Error(problem.message);

  if (!auto) issuerCache = issuer;
  return issuer;
}

export function getKakaoClientId(): string {
  return required("KAKAO_CLIENT_ID");
}

export function getKakaoClientSecret(): string {
  return required("KAKAO_CLIENT_SECRET");
}

/**
 * 카카오 콘솔에 등록한 값과 문자 단위로 정확히 같아야 한다.
 * 요청(request.url)에서 만들어 쓰지 않는다 — 프록시 뒤나 LAN 접속에서
 * 실제와 다른 값이 나오는 사례가 A/S 시스템에서 이미 실측되었다.
 *
 * **auto**로 적으면 issuer 뒤에 콜백 경로를 붙인다. 다만 여기서 auto가
 * 덜어주는 것은 이 파일을 고치는 수고뿐이다 — ⚠️ **카카오 콘솔의 등록값은
 * 우리가 바꿀 수 없다.** IP가 바뀌면 콘솔에 새 주소를 넣기 전까지 카카오
 * 로그인만 따로 깨진다(다른 로그인 수단은 멀쩡해서 더 헷갈린다).
 *
 * 그래서 카카오를 쓴다면 공유기에서 이 기계에 DHCP 예약을 걸어 주소를
 * 고정해 두는 것이 사실상 필수다. 절차는 README의 "주소 고정" 절에 있다.
 */
export function getKakaoRedirectUri(): string {
  const raw = required("KAKAO_REDIRECT_URI");
  return raw === "auto" ? `${getIssuer()}/api/kakao/callback` : raw;
}

/** 인가 요청 파라미터를 로그인 화면 왕복 동안 나르는 쿠키의 서명 키. */
export function getAuthTxSecret(): string {
  const secret = required("AUTH_TX_SECRET");
  if (secret.length < 32) {
    throw new Error("AUTH_TX_SECRET은 32자 이상이어야 합니다.");
  }
  return secret;
}

export function getKeysDir(): string {
  return process.env.AUTH_KEYS_DIR ?? "./keys";
}

export function getActiveKid(): string {
  return required("AUTH_ACTIVE_KID");
}

/**
 * 클라이언트의 redirect_uri에 http를 허용할지. 기본은 false(https만).
 * 사내망 HTTP 단계에서만 켜고, HTTPS 전환과 동시에 되돌린다.
 */
export function allowHttpRedirectUris(): boolean {
  return process.env.OIDC_ALLOW_HTTP_REDIRECT_URIS === "true";
}

/**
 * 쿠키에 secure 플래그를 붙일지. issuer가 https면 붙인다.
 * 사내망 HTTP 단계에서 secure를 붙이면 쿠키가 아예 저장되지 않아
 * 로그인이 조용히 실패한다.
 */
export function secureCookiesEnabled(): boolean {
  return getIssuer().startsWith("https://");
}

/**
 * 우리 앞에 있는 **신뢰하는** 리버스 프록시의 수. 기본 0.
 *
 * x-forwarded-for에서 진짜 클라이언트 주소를 뒤에서 몇 번째로 읽을지 정한다.
 * 자세한 근거는 lib/http/client-key.ts에 있다 — 요약하면, XFF의 앞자리는
 * 언제나 클라이언트가 쓴 값이라 위조 가능하고 프록시가 덧붙인 뒷자리만
 * 믿을 수 있다.
 *
 * **0으로 두면 IP별 구분을 포기하고 전체 공용 한도 하나로 막는다.** 지금은
 * 프록시가 없으므로 0이 맞다. 6단계에서 DSM 리버스 프록시를 세우면 1로
 * 바꾼다. 그때 바꾸는 것을 잊으면 제한이 필요 이상으로 빡빡하게 걸릴 뿐,
 * 뚫리지는 않는다 — 틀렸을 때 안전한 쪽으로 기울여 둔 기본값이다.
 *
 * 반대로 실제 프록시 수보다 크게 적으면 위조된 앞자리를 믿게 되므로,
 * 값이 정수가 아니거나 음수면 조용히 넘어가지 않고 멈춘다.
 */
let trustedProxyHopsCache: number | null = null;

export function trustedProxyHops(): number {
  if (trustedProxyHopsCache !== null) return trustedProxyHopsCache;

  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw === "") {
    trustedProxyHopsCache = 0;
    return 0;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `TRUSTED_PROXY_HOPS는 0 이상의 정수여야 합니다(받은 값: ${raw}). ` +
        "프록시가 없으면 0, DSM 리버스 프록시 뒤라면 1입니다."
    );
  }

  trustedProxyHopsCache = parsed;
  return parsed;
}
