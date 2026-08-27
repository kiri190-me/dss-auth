/**
 * 전송 설정이 서로 모순되지 않는지 보는 순수 판정.
 *
 * env.ts가 아니라 여기 있는 이유: env.ts에는 server-only가 붙어 있어 이
 * 저장소의 테스트(순수 함수용, --conditions=react-server 없이 돈다)에서 부를
 * 수 없다. 검사 자체가 안전장치인데 테스트로 고정하지 못하면 반쪽이다.
 * crypto/hash.ts가 같은 이유로 server-only를 붙이지 않았다.
 */
export type TransportProblem = {
  /** 사람이 읽을 이유. 그대로 throw 메시지가 된다. */
  message: string;
};

/**
 * 왜 검사하는가: 두 값 다 배포 때 사람이 손으로 맞춰야 하는데, 틀려도
 * **아무 증상이 없다.** 로그인은 잘 되고 화면도 정상이며 통행증만 평문으로
 * 오간다. 증상이 없는 고장은 체크리스트로 잡히지 않는다.
 */
export function checkTransportConfig(params: {
  issuer: string;
  httpRedirectUrisAllowed: boolean;
  isProduction: boolean;
}): TransportProblem | null {
  const isHttps = params.issuer.startsWith("https://");

  // 사내망 HTTP 단계에서 켜 두었다가 HTTPS로 옮기며 되돌리는 것을 잊은 경우다.
  // 이때가 "방어가 있다고 믿는" 시간이 가장 길어지는 상태다.
  if (isHttps && params.httpRedirectUrisAllowed) {
    return {
      message:
        "OIDC_ISSUER가 https인데 OIDC_ALLOW_HTTP_REDIRECT_URIS=true 입니다. " +
        "HTTPS로 옮겼다면 이 값을 false로 되돌리세요 — 켜져 있으면 http " +
        "redirect_uri가 계속 허용되어 통행증이 평문으로 오갈 수 있습니다.",
    };
  }

  // secureCookiesEnabled()가 issuer 스킴을 보므로, 이 조합에서는 세션 쿠키에
  // secure가 붙지 않는다. 같은 망에 있는 사람이 쿠키를 주워 쓸 수 있다.
  //
  // 완전히 막지 않는 이유: 사내망 HTTP로 운영할 사정이 있을 수 있다. 위험한
  // 선택을 못 하게 하는 것이 아니라, 모르고 하지는 못하게 한다.
  if (!isHttps && params.isProduction && !params.httpRedirectUrisAllowed) {
    return {
      message:
        `운영 모드인데 OIDC_ISSUER가 https가 아닙니다(${params.issuer}). ` +
        "이 상태에서는 세션 쿠키에 secure가 붙지 않습니다. HTTPS를 붙이거나, " +
        "사내망 HTTP로 운영할 사정이 있다면 OIDC_ALLOW_HTTP_REDIRECT_URIS=true 로 " +
        "명시하세요.",
    };
  }

  return null;
}
