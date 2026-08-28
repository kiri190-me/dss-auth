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

test("hashPassword로 만든 해시를 verifyPassword가 통과시킨다", async () => {
  const stored = await hashPassword("올바른-비밀번호-24자이상-입니다");
  assert.equal(await verifyPassword("올바른-비밀번호-24자이상-입니다", stored), true);
});

test("틀린 비밀번호는 거절한다", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery stapl", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("같은 비밀번호도 매번 다른 해시가 나온다(salt가 실제로 랜덤)", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  assert.notEqual(a, b);
  // 그래도 둘 다 검증은 통과해야 한다.
  assert.equal(await verifyPassword("same-password", a), true);
  assert.equal(await verifyPassword("same-password", b), true);
});

test("scrypt가 도는 동안에도 이벤트 루프가 살아 있다", async () => {
  // 이 테스트가 지키는 것: hashPassword/verifyPassword를 scryptSync로
  // 되돌리면 여기서 깨진다.
  //
  // scryptSync는 계산이 끝날 때까지(실측 62ms) Node의 이벤트 루프를 통째로
  // 멈춘다. 그러면 비상 로그인 한 건이 그 시간만큼 서버 전체를 세우고,
  // 같은 순간의 /api/oidc/token도 함께 멈춰 포털에 붙은 모든 시스템의
  // 로그인이 멈춘다. 콜백형 scrypt는 스레드풀에서 돌아 그렇지 않다.
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 5);

  await hashPassword("이벤트-루프-확인용-비밀번호");
  clearInterval(timer);

  assert.ok(
    ticks > 0,
    `scrypt가 도는 동안 타이머가 한 번도 못 돌았다(ticks=${ticks}). ` +
      "동기 scrypt로 되돌아갔는지 확인할 것."
  );
});

test("해시 형식이 깨져 있으면 예외 대신 false", async () => {
  for (const broken of [
    "",
    "not-a-hash",
    "scrypt$1$2$3",
    "bcrypt$32768$8$1$c2FsdA==$aGFzaA==",
    "scrypt$abc$8$1$c2FsdA==$aGFzaA==",
  ]) {
    assert.equal(await verifyPassword("anything", broken), false, `입력: ${broken}`);
  }
});
