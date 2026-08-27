import "server-only";
import { checkTransportConfig } from "./transport-check";

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

/**
 * 이 서버가 스스로를 부르는 주소. ID 토큰의 iss 클레임과 discovery 문서에
 * 그대로 들어가고, 각 시스템이 이 값을 대조한다.
 *
 * 끝의 슬래시를 제거한다 — "http://x/" 와 "http://x" 가 섞이면 iss 대조가
 * 실패하는데, 원인을 찾기가 매우 어려운 종류의 버그다.
 */
// 요청마다 다시 검사할 이유가 없다. 환경변수는 프로세스 수명 동안 바뀌지 않는다.
let issuerCache: string | null = null;

export function getIssuer(): string {
  if (issuerCache !== null) return issuerCache;

  const issuer = required("OIDC_ISSUER").replace(/\/+$/, "");

  // 전송 설정이 서로 모순되면 여기서 멈춘다. 판정 규칙과 그 근거는
  // transport-check.ts에 있다(테스트로 고정하기 위해 분리했다).
  const problem = checkTransportConfig({
    issuer,
    httpRedirectUrisAllowed: process.env.OIDC_ALLOW_HTTP_REDIRECT_URIS === "true",
    isProduction: process.env.NODE_ENV === "production",
  });
  if (problem) throw new Error(problem.message);

  issuerCache = issuer;
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
 */
export function getKakaoRedirectUri(): string {
  return required("KAKAO_REDIRECT_URI");
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
