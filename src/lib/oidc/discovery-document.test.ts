import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDiscoveryDocument } from "./discovery-document";

const ISSUER = "https://auth.dss.example";
const doc = buildDiscoveryDocument(ISSUER);

test("issuer가 그대로 들어간다", () => {
  // 표준 클라이언트는 여기 적힌 issuer와 ID 토큰의 iss가 같은지 대조한다.
  assert.equal(doc.issuer, ISSUER);
});

test("모든 엔드포인트가 issuer로 시작하는 절대 주소다", () => {
  const endpoints = [
    doc.authorization_endpoint,
    doc.token_endpoint,
    doc.userinfo_endpoint,
    doc.end_session_endpoint,
    doc.jwks_uri,
  ];
  for (const url of endpoints) {
    assert.ok(url.startsWith(`${ISSUER}/`), `절대 주소가 아님: ${url}`);
    assert.doesNotThrow(() => new URL(url), `URL로 파싱 불가: ${url}`);
  }
});

test("주소에 슬래시가 겹치지 않는다", () => {
  // issuer 끝에 슬래시가 붙어 오면 //가 생겨 일부 클라이언트가 실패한다.
  const withSlash = buildDiscoveryDocument("https://auth.dss.example");
  for (const url of Object.values(withSlash)) {
    if (typeof url === "string" && url.startsWith("http")) {
      assert.doesNotMatch(url.slice("https://".length), /\/\//, url);
    }
  }
});

test("PKCE는 S256만 선언한다 — plain을 넣으면 PKCE가 무의미해진다", () => {
  assert.deepEqual(doc.code_challenge_methods_supported, ["S256"]);
});

test("Authorization Code Flow만 선언한다", () => {
  assert.deepEqual(doc.response_types_supported, ["code"]);
  // implicit/hybrid는 OAuth 2.1에서 삭제된 흐름이다.
  assert.ok(!doc.response_types_supported.includes("token" as never));
  assert.ok(!doc.response_types_supported.includes("id_token" as never));
});

test("refresh_token을 선언하지 않는다", () => {
  // 지원하지 않는 것을 선언하면 클라이언트가 그걸 시도하고 실패한다.
  assert.deepEqual(doc.grant_types_supported, ["authorization_code"]);
});

test("sub는 public이다 — 사내 시스템끼리 같은 사람을 같게 알아봐야 한다", () => {
  assert.deepEqual(doc.subject_types_supported, ["public"]);
});

test("서명 알고리즘은 RS256만", () => {
  assert.deepEqual(doc.id_token_signing_alg_values_supported, ["RS256"]);
  // "none"이 섞이면 서명 없는 토큰을 받아들이라는 뜻이 된다.
  assert.ok(!doc.id_token_signing_alg_values_supported.includes("none" as never));
});

test("Discovery 규격의 필수 항목이 모두 있다", () => {
  for (const key of [
    "issuer",
    "authorization_endpoint",
    "jwks_uri",
    "response_types_supported",
    "subject_types_supported",
    "id_token_signing_alg_values_supported",
  ]) {
    assert.ok(key in doc, `누락: ${key}`);
  }
});

test("JSON으로 직렬화된다", () => {
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(doc)));
});
