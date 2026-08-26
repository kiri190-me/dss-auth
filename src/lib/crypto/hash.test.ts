import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, safeEqual, sha256Hex, verifyPassword } from "./hash";

test("sha256Hex는 같은 입력에 같은 값을, 다른 입력에 다른 값을 낸다", () => {
  assert.equal(sha256Hex("abc"), sha256Hex("abc"));
  assert.notEqual(sha256Hex("abc"), sha256Hex("abd"));
  assert.match(sha256Hex("abc"), /^[0-9a-f]{64}$/);
});

test("safeEqual은 길이가 달라도 예외 없이 false를 낸다", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual("abc", ""), false);
});

test("hashPassword로 만든 해시를 verifyPassword가 통과시킨다", () => {
  const stored = hashPassword("올바른-비밀번호-24자이상-입니다");
  assert.equal(verifyPassword("올바른-비밀번호-24자이상-입니다", stored), true);
});

test("틀린 비밀번호는 거절한다", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery stapl", stored), false);
  assert.equal(verifyPassword("", stored), false);
});

test("같은 비밀번호도 매번 다른 해시가 나온다(salt가 실제로 랜덤)", () => {
  const a = hashPassword("same-password");
  const b = hashPassword("same-password");
  assert.notEqual(a, b);
  // 그래도 둘 다 검증은 통과해야 한다.
  assert.equal(verifyPassword("same-password", a), true);
  assert.equal(verifyPassword("same-password", b), true);
});

test("해시 형식이 깨져 있으면 예외 대신 false", () => {
  for (const broken of [
    "",
    "not-a-hash",
    "scrypt$1$2$3",
    "bcrypt$32768$8$1$c2FsdA==$aGFzaA==",
    "scrypt$abc$8$1$c2FsdA==$aGFzaA==",
  ]) {
    assert.equal(verifyPassword("anything", broken), false, `입력: ${broken}`);
  }
});
