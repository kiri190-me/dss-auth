import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAuthorizeParams } from "./authorize-params";

const VALID = {
  response_type: "code",
  scope: "openid profile",
  state: "s".repeat(43),
  nonce: "n".repeat(43),
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
};

function build(overrides: Record<string, string | null> = {}): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...VALID, ...overrides })) {
    if (value !== null) query.set(key, value);
  }
  return query;
}

test("정상 요청을 통과시킨다", () => {
  const result = parseAuthorizeParams(build());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.params.state, VALID.state);
    assert.equal(result.params.nonce, VALID.nonce);
    assert.equal(result.params.prompt, null);
  }
});

test("response_type이 code가 아니면 unsupported_response_type", () => {
  for (const bad of ["token", "id_token", "code token", ""]) {
    const result = parseAuthorizeParams(build({ response_type: bad }));
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.equal(result.failure.error, "unsupported_response_type");
  }
});

test("scope에 openid가 없으면 invalid_scope", () => {
  for (const bad of ["profile", "", "openidx", "not-openid"]) {
    const result = parseAuthorizeParams(build({ scope: bad }));
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.equal(result.failure.error, "invalid_scope");
  }
});

test("scope 안 어디에 있든 openid를 찾는다", () => {
  for (const good of ["openid", "profile openid", "openid email profile"]) {
    assert.equal(parseAuthorizeParams(build({ scope: good })).ok, true, good);
  }
});

test("state가 없거나 짧으면 invalid_request", () => {
  for (const bad of [null, "", "short"]) {
    const result = parseAuthorizeParams(build({ state: bad }));
    assert.equal(result.ok, false, String(bad));
    if (!result.ok) assert.equal(result.failure.error, "invalid_request");
  }
});

test("nonce가 없거나 짧으면 invalid_request", () => {
  for (const bad of [null, "", "short"]) {
    const result = parseAuthorizeParams(build({ nonce: bad }));
    assert.equal(result.ok, false, String(bad));
    if (!result.ok) assert.equal(result.failure.error, "invalid_request");
  }
});

test("PKCE는 필수다", () => {
  const result = parseAuthorizeParams(build({ code_challenge: null }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.error, "invalid_request");
});

test("code_challenge_method는 S256만 받는다 — plain은 거절", () => {
  // plain은 challenge와 verifier가 같아서 PKCE가 아무것도 막지 못한다.
  for (const bad of ["plain", "S512", "", null]) {
    const result = parseAuthorizeParams(build({ code_challenge_method: bad }));
    assert.equal(result.ok, false, String(bad));
  }
});

test("파라미터가 중복되면 거절한다 (파라미터 오염 방지)", () => {
  const query = build();
  query.append("scope", "openid");
  const result = parseAuthorizeParams(query);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.error, "invalid_request");
    assert.match(result.failure.description, /중복/);
  }
});

test("prompt는 아는 값만 담고 모르는 값은 무시한다", () => {
  for (const [input, expected] of [
    ["none", "none"],
    ["login", "login"],
    ["consent", null],
    ["select_account", null],
    ["", null],
  ] as const) {
    const result = parseAuthorizeParams(build({ prompt: input }));
    assert.equal(result.ok, true, input);
    if (result.ok) assert.equal(result.params.prompt, expected, input);
  }
});

test("모르는 파라미터가 섞여 있어도 통과한다 (규격상 무시)", () => {
  const query = build();
  query.set("max_age", "300");
  query.set("acr_values", "urn:example");
  assert.equal(parseAuthorizeParams(query).ok, true);
});

test("오류 설명에 내부 사정이 새지 않는다", () => {
  const result = parseAuthorizeParams(build({ scope: "profile" }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    // 이 문자열은 브라우저 주소창까지 그대로 나간다.
    assert.doesNotMatch(result.failure.description, /select|table|users|sql/i);
  }
});
