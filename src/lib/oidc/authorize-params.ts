import type { OidcFailure } from "./errors";

/**
 * state/nonce 최소 길이.
 *
 * 규격이 길이를 정하지는 않지만, 짧으면 각각이 막아야 할 것(로그인 CSRF,
 * 토큰 재사용)을 막지 못한다. 표준 라이브러리(openid-client, next-auth)는
 * 32바이트 랜덤 = 43자를 만들므로 이 기준을 여유롭게 넘는다.
 * 연동 가이드에도 명시한다.
 */
const MIN_ENTROPY_LENGTH = 16;

export type AuthorizeParams = {
  scope: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  /** 이해하는 값만 담는다. 모르는 값은 규격대로 무시한다. */
  prompt: "none" | "login" | null;
};

export type AuthorizeParamsResult =
  | { ok: true; params: AuthorizeParams }
  | { ok: false; failure: OidcFailure };

function fail(error: OidcFailure["error"], description: string): AuthorizeParamsResult {
  return { ok: false, failure: { error, description } };
}

/**
 * 인가 요청 파라미터 검증.
 *
 * ⚠️ 이 함수는 client_id와 redirect_uri를 **검증하지 않는다.** 그 둘은
 * 이 함수를 부르기 전에 이미 확인되어 있어야 한다. 순서가 중요한 이유:
 * 여기서 나온 실패는 redirect_uri로 실려 나가는데, redirect_uri 자체를
 * 못 믿는 상태에서 리다이렉트하면 열린 리다이렉터가 되기 때문이다.
 */
export function parseAuthorizeParams(query: URLSearchParams): AuthorizeParamsResult {
  // 같은 파라미터가 두 번 오면 거절한다. 서버마다 첫 값을 읽는지 마지막
  // 값을 읽는지가 달라서, 앞단 프록시와 우리가 서로 다른 값을 보게
  // 만드는 파라미터 오염(parameter pollution) 공격이 성립한다.
  for (const key of [
    "response_type",
    "scope",
    "state",
    "nonce",
    "code_challenge",
    "code_challenge_method",
    "prompt",
  ]) {
    if (query.getAll(key).length > 1) {
      return fail("invalid_request", `${key} 파라미터가 중복되었습니다.`);
    }
  }

  if (query.get("response_type") !== "code") {
    return fail(
      "unsupported_response_type",
      "response_type은 code만 지원합니다."
    );
  }

  const scope = query.get("scope") ?? "";
  // 공백으로 나눈 목록에 openid가 있어야 OIDC 요청이다. 없으면 평범한
  // OAuth 요청이고, 우리는 신원 제공만 하므로 받을 이유가 없다.
  if (!scope.split(/\s+/).filter(Boolean).includes("openid")) {
    return fail("invalid_scope", "scope에 openid가 있어야 합니다.");
  }

  const state = query.get("state") ?? "";
  if (state.length < MIN_ENTROPY_LENGTH) {
    return fail(
      "invalid_request",
      `state는 ${MIN_ENTROPY_LENGTH}자 이상이어야 합니다.`
    );
  }

  const nonce = query.get("nonce") ?? "";
  if (nonce.length < MIN_ENTROPY_LENGTH) {
    return fail(
      "invalid_request",
      `nonce는 ${MIN_ENTROPY_LENGTH}자 이상이어야 합니다.`
    );
  }

  const codeChallenge = query.get("code_challenge") ?? "";
  if (!codeChallenge) {
    return fail("invalid_request", "code_challenge가 필요합니다(PKCE 필수).");
  }
  // plain은 challenge와 verifier가 같은 값이라 PKCE를 무의미하게 만든다.
  if (query.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "code_challenge_method는 S256만 지원합니다.");
  }

  const rawPrompt = query.get("prompt");
  const prompt = rawPrompt === "none" || rawPrompt === "login" ? rawPrompt : null;

  return { ok: true, params: { scope, state, nonce, codeChallenge, prompt } };
}
