import assert from "node:assert/strict";
import { test } from "node:test";
import { rateLimitKey, SHARED_CLIENT_KEY, trustedClientIp } from "./client-key";

test("hops가 0이면 XFF를 전혀 믿지 않는다", () => {
  // 프록시가 없으면 이 값이 소켓 주소인지 클라이언트가 쓴 값인지 구분할 수
  // 없다. 구분할 수 없으면 믿지 않는다.
  assert.equal(trustedClientIp("203.0.113.9", 0), null);
  assert.equal(trustedClientIp("203.0.113.9, 192.168.0.2", 0), null);
});

test("hops가 1이면 마지막 항목을 쓴다 — 첫 항목은 위조 가능하다", () => {
  // 공격자가 "1.2.3.4"를 심어 보내도 프록시가 뒤에 진짜 주소를 덧붙인다.
  assert.equal(trustedClientIp("1.2.3.4, 192.168.0.2", 1), "192.168.0.2");
  assert.equal(trustedClientIp("192.168.0.2", 1), "192.168.0.2");
});

test("위조된 앞자리를 아무리 늘려도 마지막만 본다", () => {
  const forged = Array.from({ length: 50 }, (_, i) => `10.0.0.${i}`).join(", ");
  assert.equal(trustedClientIp(`${forged}, 192.168.0.7`, 1), "192.168.0.7");
});

test("hops가 2면 뒤에서 두 번째를 쓴다", () => {
  assert.equal(
    trustedClientIp("1.2.3.4, 192.168.0.2, 10.0.0.1", 2),
    "192.168.0.2"
  );
});

test("항목이 hops보다 적으면 믿지 않는다", () => {
  // 프록시를 거치지 않고 들어왔거나 설정이 틀렸다는 뜻이다.
  assert.equal(trustedClientIp("192.168.0.2", 2), null);
  assert.equal(trustedClientIp(null, 1), null);
  assert.equal(trustedClientIp("", 1), null);
});

test("IP 형식이 아니면 거절한다", () => {
  // 확인하지 않으면 임의의 긴 문자열이 열쇠가 되어 기억을 부풀리는 도구가 된다.
  for (const bad of ["unknown", "not-an-ip", "x".repeat(5000), "   ", "999.1.1.1"]) {
    assert.equal(trustedClientIp(bad, 1), null, `입력: ${bad.slice(0, 20)}`);
  }
});

test("IPv6와 IPv4 매핑 주소를 받아들인다", () => {
  assert.equal(trustedClientIp("::1", 1), "::1");
  assert.equal(trustedClientIp("::ffff:127.0.0.1", 1), "::ffff:127.0.0.1");
  assert.equal(
    trustedClientIp("2001:db8::1", 1),
    "2001:db8::1"
  );
});

test("뒤에 붙은 포트를 떼어낸다 — 안 떼면 요청마다 다른 열쇠가 된다", () => {
  assert.equal(trustedClientIp("192.168.0.2:54321", 1), "192.168.0.2");
  assert.equal(trustedClientIp("[2001:db8::1]:54321", 1), "2001:db8::1");
  assert.equal(trustedClientIp("[::1]", 1), "::1");
});

test("공백이 섞여 있어도 같은 열쇠가 나온다", () => {
  assert.equal(trustedClientIp("1.2.3.4,   192.168.0.2  ", 1), "192.168.0.2");
});

test("믿을 수 없으면 모두가 한 통을 쓴다", () => {
  // IP별로 나눌 수 없다고 제한을 포기하면 안 된다.
  assert.equal(rateLimitKey("203.0.113.9", 0), SHARED_CLIENT_KEY);
  assert.equal(rateLimitKey(null, 1), SHARED_CLIENT_KEY);
  assert.equal(rateLimitKey("garbage", 1), SHARED_CLIENT_KEY);
  // 믿을 수 있으면 그 주소가 열쇠가 된다.
  assert.equal(rateLimitKey("1.2.3.4, 192.168.0.2", 1), "192.168.0.2");
});
