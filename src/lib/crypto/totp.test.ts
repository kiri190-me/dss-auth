import assert from "node:assert/strict";
import { test } from "node:test";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  timeStep,
  totpCode,
  totpUri,
  verifyTotp,
} from "./totp";

/**
 * RFC 6238 부록 B의 시험값.
 *
 * 직접 구현한 암호 코드를 믿을 수 있는 유일한 근거다. 비밀키는 아스키
 * "12345678901234567890"이고, 표에 적힌 값은 8자리다.
 */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

const RFC_VECTORS: Array<{ time: number; expected8: string }> = [
  { time: 59, expected8: "94287082" },
  { time: 1111111109, expected8: "07081804" },
  { time: 1111111111, expected8: "14050471" },
  { time: 1234567890, expected8: "89005924" },
  { time: 2000000000, expected8: "69279037" },
  { time: 20000000000, expected8: "65353130" },
];

test("RFC 6238 시험값과 일치한다 (8자리)", () => {
  for (const { time, expected8 } of RFC_VECTORS) {
    assert.equal(totpCode(RFC_SECRET, timeStep(time), 8), expected8, `T=${time}`);
  }
});

test("6자리는 8자리의 뒤 여섯 자리다", () => {
  for (const { time, expected8 } of RFC_VECTORS) {
    assert.equal(totpCode(RFC_SECRET, timeStep(time)), expected8.slice(-6), `T=${time}`);
  }
});

test("base32는 왕복한다", () => {
  for (const text of ["", "a", "ab", "abc", "abcd", "abcde", "12345678901234567890"]) {
    const bytes = Buffer.from(text, "ascii");
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes, text);
  }
});

test("사람이 옮겨 적은 형태를 너그럽게 받는다", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  const messy = secret.toLowerCase().replace(/(.{4})/g, "$1 ");
  assert.deepEqual(base32Decode(messy), base32Decode(secret));
});

test("base32에 없는 글자는 거절한다", () => {
  assert.throws(() => base32Decode("ABC1"), /base32/); // 1은 알파벳에 없다
  assert.throws(() => base32Decode("ABC0"), /base32/); // 0도 없다(O와 헷갈려서)
});

test("새 비밀키는 32자 base32다 (20바이트)", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(secret).length, 20);
});

test("서로 다른 비밀키가 나온다", () => {
  assert.notEqual(generateTotpSecret(), generateTotpSecret());
});

const NOW = 1111111111;

test("지금 코드는 통과한다", () => {
  const code = totpCode(RFC_SECRET, timeStep(NOW));
  const result = verifyTotp({ secret: RFC_SECRET, code, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.step, timeStep(NOW));
});

test("앞뒤 한 칸(±30초)까지 받아 준다", () => {
  for (const drift of [-30, 30]) {
    const code = totpCode(RFC_SECRET, timeStep(NOW + drift));
    assert.equal(verifyTotp({ secret: RFC_SECRET, code, now: NOW }).ok, true, `${drift}초`);
  }
});

test("두 칸 넘게 어긋나면 거절한다", () => {
  // 창을 넓힐수록 추측 성공률이 올라간다. 한 칸에서 멈춘 판단을 고정한다.
  for (const drift of [-90, 90]) {
    const code = totpCode(RFC_SECRET, timeStep(NOW + drift));
    assert.equal(verifyTotp({ secret: RFC_SECRET, code, now: NOW }).ok, false, `${drift}초`);
  }
});

test("이미 쓴 코드는 다시 통과하지 못한다", () => {
  // 어깨너머로 본 코드가 30초 안에 재사용되는 것을 막는 지점이다.
  const step = timeStep(NOW);
  const code = totpCode(RFC_SECRET, step);
  const first = verifyTotp({ secret: RFC_SECRET, code, now: NOW });
  assert.equal(first.ok, true);

  const replay = verifyTotp({
    secret: RFC_SECRET,
    code,
    now: NOW,
    lastUsedStep: first.ok ? first.step : null,
  });
  assert.equal(replay.ok, false);
});

test("이전 칸의 코드도 이미 쓴 칸 이하면 거절한다", () => {
  const step = timeStep(NOW);
  const older = totpCode(RFC_SECRET, step - 1);
  assert.equal(
    verifyTotp({ secret: RFC_SECRET, code: older, now: NOW, lastUsedStep: step }).ok,
    false
  );
});

test("다음 칸은 이미 쓴 칸 이후라 통과한다", () => {
  const step = timeStep(NOW);
  const next = totpCode(RFC_SECRET, step + 1);
  assert.equal(
    verifyTotp({ secret: RFC_SECRET, code: next, now: NOW, lastUsedStep: step }).ok,
    true
  );
});

test("모양이 아닌 값은 HMAC을 계산하기도 전에 거절한다", () => {
  for (const code of ["", "12345", "1234567", "abcdef", "12 34 5", "�"]) {
    assert.equal(verifyTotp({ secret: RFC_SECRET, code, now: NOW }).ok, false, `"${code}"`);
  }
});

test("공백과 붙임표는 지우고 본다", () => {
  const code = totpCode(RFC_SECRET, timeStep(NOW));
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const dashed = `${code.slice(0, 3)}-${code.slice(3)}`;
  assert.equal(verifyTotp({ secret: RFC_SECRET, code: spaced, now: NOW }).ok, true);
  assert.equal(verifyTotp({ secret: RFC_SECRET, code: dashed, now: NOW }).ok, true);
});

test("비밀키가 깨져 있으면 어떤 코드도 통과시키지 않는다", () => {
  // 예외를 밖으로 던지면 로그인 화면이 통째로 죽는다. 조용히 거절한다.
  const result = verifyTotp({ secret: "이건 base32가 아니다", code: "123456", now: NOW });
  assert.equal(result.ok, false);
});

test("otpauth 주소에 필요한 것이 다 들어 있다", () => {
  const uri = totpUri({ secret: RFC_SECRET, account: "dssadmin", issuer: "DSS 통합 로그인" });
  assert.ok(uri.startsWith("otpauth://totp/"));
  assert.ok(uri.includes(`secret=${RFC_SECRET}`));
  assert.ok(uri.includes("digits=6"));
  assert.ok(uri.includes("period=30"));
  assert.ok(uri.includes("algorithm=SHA1"));
  // 발급자가 이름표와 질의 양쪽에 들어가야 앱들이 제대로 묶는다.
  assert.ok(uri.includes("dssadmin"));
});
