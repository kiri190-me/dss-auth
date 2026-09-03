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

// ───── {lan} 자리표시자 ─────
//
// 여기서 확인하려는 것은 "편해졌다"가 아니라 **느슨해지지 않았다**이다.
// 자리표시자는 이 서버 자신의 주소로만 펼쳐지고, 펼친 뒤의 비교는
// 그대로 정확 일치다.

const LAN = ["192.168.0.13", "172.23.224.1"];
const WITH_PLACEHOLDER = ["http://{lan}:3000/api/auth/sso/callback"];

test("{lan}은 이 기계의 주소로 펼쳐져 통과한다", () => {
  assert.equal(
    isRegisteredRedirectUri(
      "http://192.168.0.13:3000/api/auth/sso/callback",
      WITH_PLACEHOLDER,
      true,
      LAN
    ),
    true
  );
});

test("이 기계가 가진 다른 주소도 각각 정확히 대조된다", () => {
  assert.equal(
    isRegisteredRedirectUri(
      "http://172.23.224.1:3000/api/auth/sso/callback",
      WITH_PLACEHOLDER,
      true,
      LAN
    ),
    true
  );
});

test("우리 것이 아닌 주소는 {lan}이 있어도 거절 — 와일드카드가 아니다", () => {
  for (const bad of [
    "http://192.168.0.99:3000/api/auth/sso/callback", // 같은 망의 남의 PC
    "http://10.0.0.1:3000/api/auth/sso/callback",
    "http://evil.com:3000/api/auth/sso/callback",
  ]) {
    assert.equal(isRegisteredRedirectUri(bad, WITH_PLACEHOLDER, true, LAN), false, bad);
  }
});

test("호스트만 펼칠 뿐, 포트와 경로는 여전히 정확히 같아야 한다", () => {
  for (const bad of [
    "http://192.168.0.13:3001/api/auth/sso/callback", // 포트가 다르다
    "http://192.168.0.13:3000/api/auth/sso/callback/", // 끝 슬래시
    "http://192.168.0.13:3000/api/auth/sso/callback?next=evil",
    "http://192.168.0.13:3000/evil",
  ]) {
    assert.equal(isRegisteredRedirectUri(bad, WITH_PLACEHOLDER, true, LAN), false, bad);
  }
});

test("자리표시자를 그대로 요청해도 통과하지 못한다", () => {
  // 요청값은 펼치지 않는다. 밖에서 온 값에 해석을 붙이는 순간 규칙이 무너진다.
  assert.equal(
    isRegisteredRedirectUri(
      "http://{lan}:3000/api/auth/sso/callback",
      WITH_PLACEHOLDER,
      true,
      LAN
    ),
    false
  );
});

test("주소를 못 찾으면 {lan} 등록값은 아무것도 통과시키지 않는다", () => {
  assert.equal(
    isRegisteredRedirectUri(
      "http://192.168.0.13:3000/api/auth/sso/callback",
      WITH_PLACEHOLDER,
      true,
      []
    ),
    false
  );
});

test("lanAddresses를 넘기지 않은 호출자는 막히는 쪽으로 실패한다", () => {
  assert.equal(
    isRegisteredRedirectUri(
      "http://192.168.0.13:3000/api/auth/sso/callback",
      WITH_PLACEHOLDER,
      true
    ),
    false
  );
});

test("자리표시자가 있어도 allowHttp 규칙은 그대로다", () => {
  assert.equal(
    isRegisteredRedirectUri(
      "http://192.168.0.13:3000/api/auth/sso/callback",
      WITH_PLACEHOLDER,
      false,
      LAN
    ),
    false
  );
});

test("고정 주소와 자리표시자를 섞어 등록해도 각각 그대로 동작한다", () => {
  const mixed = ["https://as.dss.example/cb", "http://{lan}:3000/cb"];
  assert.equal(isRegisteredRedirectUri("https://as.dss.example/cb", mixed, true, LAN), true);
  assert.equal(isRegisteredRedirectUri("http://192.168.0.13:3000/cb", mixed, true, LAN), true);
  assert.equal(isRegisteredRedirectUri("http://192.168.0.14:3000/cb", mixed, true, LAN), false);
});
