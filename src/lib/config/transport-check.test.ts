import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTransportConfig } from "./transport-check";

const HTTPS = "https://sso.example.com";
const HTTP = "http://192.168.1.132:3100";

test("사내망 HTTP 개발 단계 — 허용을 켜 둔 상태는 통과", () => {
  assert.equal(
    checkTransportConfig({
      issuer: HTTP,
      httpRedirectUrisAllowed: true,
      isProduction: false,
    }),
    null
  );
});

test("HTTPS + 허용 꺼짐 — 목표 상태는 통과", () => {
  assert.equal(
    checkTransportConfig({
      issuer: HTTPS,
      httpRedirectUrisAllowed: false,
      isProduction: true,
    }),
    null
  );
});

test("HTTPS인데 http 허용이 켜져 있으면 막는다", () => {
  const problem = checkTransportConfig({
    issuer: HTTPS,
    httpRedirectUrisAllowed: true,
    isProduction: true,
  });
  assert.ok(problem, "막아야 한다");
  assert.match(problem.message, /false로 되돌리세요/);
});

test("개발 중이어도 그 조합은 똑같이 막는다", () => {
  // 개발이라고 봐주면, 개발에서 통과한 설정을 그대로 옮겨 놓고 안심한다.
  const problem = checkTransportConfig({
    issuer: HTTPS,
    httpRedirectUrisAllowed: true,
    isProduction: false,
  });
  assert.ok(problem);
});

test("운영인데 http이고 선언도 없으면 막는다", () => {
  const problem = checkTransportConfig({
    issuer: HTTP,
    httpRedirectUrisAllowed: false,
    isProduction: true,
  });
  assert.ok(problem, "막아야 한다");
  assert.match(problem.message, /secure가 붙지 않습니다/);
  // 무엇이 문제인 주소인지 그대로 보여준다 — 비밀이 아니고, 없으면 진단이 는다.
  assert.match(problem.message, /192\.168\.1\.132/);
});

test("운영 HTTP를 명시적으로 선언했으면 통과시킨다", () => {
  // 위험한 선택을 못 하게 하는 것이 아니라, 모르고 하지 못하게 한다.
  assert.equal(
    checkTransportConfig({
      issuer: HTTP,
      httpRedirectUrisAllowed: true,
      isProduction: true,
    }),
    null
  );
});

test("개발 HTTP + 허용 꺼짐 — 아무 말도 하지 않는다", () => {
  assert.equal(
    checkTransportConfig({
      issuer: HTTP,
      httpRedirectUrisAllowed: false,
      isProduction: false,
    }),
    null
  );
});
