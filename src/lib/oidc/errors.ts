/**
 * OIDC/OAuth 2.0 표준 오류 코드 (RFC 6749 §4.1.2.1, OIDC Core §3.1.2.6).
 *
 * 우리 마음대로 문자열을 만들지 않는 이유: 각 시스템이 표준 라이브러리로
 * 붙는데, 그 라이브러리들이 이 코드값을 보고 분기한다. 예컨대
 * login_required는 "조용히 다시 인증 요청하라"는 뜻으로 처리된다.
 */
export const OIDC_ERRORS = [
  "invalid_request",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "login_required",
  "interaction_required",
  "consent_required",
  // 토큰 엔드포인트 전용
  "invalid_client",
  "invalid_grant",
  "unsupported_grant_type",
] as const;

export type OidcErrorCode = (typeof OIDC_ERRORS)[number];

export type OidcFailure = {
  error: OidcErrorCode;
  /**
   * 사람이 읽을 설명. 여기에 내부 사정(어느 테이블에서 못 찾았는지 등)을
   * 담지 않는다 — 이 값은 브라우저 주소창까지 그대로 나간다.
   */
  description: string;
};
