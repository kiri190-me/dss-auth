import assert from "node:assert/strict";
import { test } from "node:test";
import { isRegisteredRedirectUri } from "./redirect-uri";

const REGISTERED = [
  "https://as.dss.example/api/auth/sso/callback",
  "http://192.168.1.132:3000/api/auth/sso/callback",
];

test("등록된 값과 정확히 같으면 통과", () => {
  assert.equal(
    isRegisteredRedirectUri(REGISTERED[0], REGISTERED, false),
    true
  );
});

test("끝 슬래시 하나만 달라도 거절 — 정규화하지 않는다", () => {
  assert.equal(
    isRegisteredRedirectUri(`${REGISTERED[0]}/`, REGISTERED, false),
    false
  );
});

test("대소문자가 다르면 거절", () => {
  assert.equal(
    isRegisteredRedirectUri(
      "https://AS.dss.example/api/auth/sso/callback",
      REGISTERED,
      false
    ),
    false
  );
});

test("경로를 덧붙이는 접두사 공격을 거절", () => {
  // 접두사 일치를 허용했다면 통과했을 값이다.
  assert.equal(
    isRegisteredRedirectUri(
      `${REGISTERED[0]}/../../evil`,
      REGISTERED,
      false
    ),
    false
  );
  assert.equal(
    isRegisteredRedirectUri(`${REGISTERED[0]}.evil.com`, REGISTERED, false),
    false
  );
});

test("쿼리스트링을 덧붙이면 거절", () => {
  assert.equal(
    isRegisteredRedirectUri(`${REGISTERED[0]}?next=evil`, REGISTERED, false),
    false
  );
});

test("프래그먼트가 있으면 거절", () => {
  assert.equal(
    isRegisteredRedirectUri(`${REGISTERED[0]}#x`, REGISTERED, false),
    false
  );
});

test("사용자 정보(@)로 호스트를 위장하는 시도를 거절", () => {
  // 사람 눈에는 as.dss.example로 보이지만 실제 목적지는 evil.com이다.
  assert.equal(
    isRegisteredRedirectUri(
      "https://as.dss.example@evil.com/api/auth/sso/callback",
      REGISTERED,
      false
    ),
    false
  );
});

test("allowHttp가 꺼져 있으면 http를 거절한다", () => {
  assert.equal(isRegisteredRedirectUri(REGISTERED[1], REGISTERED, false), false);
});

test("allowHttp가 켜져 있으면 등록된 http는 통과한다", () => {
  assert.equal(isRegisteredRedirectUri(REGISTERED[1], REGISTERED, true), true);
});

test("allowHttp가 켜져 있어도 등록되지 않은 http는 거절", () => {
  assert.equal(
    isRegisteredRedirectUri("http://evil.com/cb", REGISTERED, true),
    false
  );
});

test("https/http가 아닌 스킴은 거절", () => {
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://a.com/cb",
  ]) {
    assert.equal(isRegisteredRedirectUri(bad, REGISTERED, true), false, bad);
  }
});

test("URL로 파싱되지 않는 값은 예외 없이 거절", () => {
  for (const bad of ["", "not a url", "//evil.com/cb", "/relative/path"]) {
    assert.equal(isRegisteredRedirectUri(bad, REGISTERED, true), false, bad);
  }
});

test("등록 목록이 비어 있으면 무엇도 통과하지 못한다", () => {
  assert.equal(isRegisteredRedirectUri(REGISTERED[0], [], false), false);
});
