/**
 * OIDC Discovery 문서 (OpenID Connect Discovery 1.0 §3).
 *
 * 이 문서 하나가 연동의 전부다. 다른 팀 개발자는 issuer 주소만 알면
 * openid-client나 next-auth가 여기를 읽어 나머지 주소를 전부 알아낸다.
 * "우리 규격 설명서를 읽고 직접 구현하세요"와는 협조 난이도가 다르다.
 *
 * 순수 함수로 둔 이유: 값이 하나만 틀려도 모든 연동이 조용히 깨지는데,
 * 서버를 띄우지 않고 테스트로 확인할 수 있어야 한다.
 */

/** 우리가 지원한다고 선언하는 것만 적는다. 안 하는 것을 적으면 클라이언트가 그걸 시도한다. */
export function buildDiscoveryDocument(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/oidc/authorize`,
    token_endpoint: `${issuer}/api/oidc/token`,
    userinfo_endpoint: `${issuer}/api/oidc/userinfo`,
    end_session_endpoint: `${issuer}/api/oidc/logout`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,

    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    // refresh_token은 일부러 넣지 않는다. 각 시스템이 자기 세션 쿠키로
    // 로그인을 유지하고, 만료되면 /authorize로 한 번 다녀오면 된다.
    // 장수명 자격증명을 만들지 않는 것이 탈취 시 피해를 줄인다.
    // 정직하게 적어두면 표준 클라이언트가 알아서 그에 맞게 동작한다.
    grant_types_supported: ["authorization_code"],
    // public이면 모든 클라이언트가 같은 sub를 본다. 사내 시스템끼리는
    // 같은 사람을 같은 사람으로 알아봐야 하므로 pairwise가 아니라 public이다.
    // (카카오가 우리에게 주는 sub는 pairwise지만, 그건 카카오와 우리 사이의 얘기다.)
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
    ],
    // plain은 넣지 않는다 — challenge와 verifier가 같아 PKCE가 무의미해진다.
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "profile", "email"],
    claims_supported: [
      "iss",
      "sub",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "sid",
      "name",
      "preferred_username",
      "email",
      // 표준 클레임이 아니다. 값은 받는 시스템마다 다르고(그 시스템의 역할
      // 목록에서 온다), 지정되지 않았으면 아예 실리지 않는다.
      "role",
    ],
    // 지원하지 않음을 명시한다. 생략하면 기본값이 false지만, 적어두면
    // 연동하는 쪽이 문서를 뒤지지 않아도 된다.
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
  };
}

export type DiscoveryDocument = ReturnType<typeof buildDiscoveryDocument>;
