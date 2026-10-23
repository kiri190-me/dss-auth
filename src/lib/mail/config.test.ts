import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAIL_ENV_KEYS,
  describeMailConfig,
  loadMailConfig,
  type MailEnv,
} from "./config";

/**
 * 메일 서버 설정 읽기.
 *
 * 🔴 두 가지를 잰다: **빠진 칸을 이름으로 말해 주는가**(조용히 꺼져 있으면
 * 결재 알림이 안 나가는 것을 아무도 모른다), 그리고 **비밀번호가 밖으로 새지
 * 않는가**.
 *
 * 🔵 환경을 인자로 넣는다 — 전역 `process.env` 를 고치면 이 프로세스에서 함께
 * 도는 다른 시험이 엉뚱한 설정을 본다.
 */

const 제대로된설정: MailEnv = {
  [MAIL_ENV_KEYS.host]: "smtp.example.test",
  [MAIL_ENV_KEYS.port]: "587",
  [MAIL_ENV_KEYS.from]: "DSS 통합 로그인 <no-reply@example.test>",
  [MAIL_ENV_KEYS.user]: "no-reply@example.test",
  [MAIL_ENV_KEYS.password]: "비밀번호가짜",
};

test("제대로 적혀 있으면 그대로 읽는다", () => {
  const result = loadMailConfig(제대로된설정);
  assert.ok(result.ok);
  assert.equal(result.config.host, "smtp.example.test");
  assert.equal(result.config.port, 587);
  assert.equal(result.config.secure, "starttls");
  assert.equal(result.config.legacyTls, false);
});

test("🔴 빠진 칸을 이름으로 말해 준다 — 조용히 꺼져 있으면 아무도 모른다", () => {
  const result = loadMailConfig({});
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.deepEqual(result.missing, [
    MAIL_ENV_KEYS.host,
    MAIL_ENV_KEYS.port,
    MAIL_ENV_KEYS.from,
  ]);
  assert.ok(result.message.includes(MAIL_ENV_KEYS.host));
});

test("보안 방식을 안 적었으면 포트에서 추론한다 — 465 는 SSL", () => {
  const result = loadMailConfig({ ...제대로된설정, [MAIL_ENV_KEYS.port]: "465" });
  assert.ok(result.ok);
  assert.equal(result.config.secure, "ssl");
});

test("보안 방식을 적었으면 그것을 쓴다. 모르는 글자는 거절한다", () => {
  const 적음 = loadMailConfig({ ...제대로된설정, [MAIL_ENV_KEYS.secure]: "NONE" });
  assert.ok(적음.ok);
  assert.equal(적음.config.secure, "none");

  const 모름 = loadMailConfig({ ...제대로된설정, [MAIL_ENV_KEYS.secure]: "tls" });
  assert.equal(모름.ok, false);
});

test("포트가 숫자가 아니면 거절한다", () => {
  for (const 값 of ["여든일곱", "0", "70000", "58 7"]) {
    const result = loadMailConfig({ ...제대로된설정, [MAIL_ENV_KEYS.port]: 값 });
    assert.equal(result.ok, false, `"${값}" 을 받아들였다`);
  }
});

test("계정만 있고 비밀번호가 없으면 붙어 보기 전에 막는다", () => {
  const result = loadMailConfig({ ...제대로된설정, [MAIL_ENV_KEYS.password]: "" });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.deepEqual(result.missing, [MAIL_ENV_KEYS.password]);
});

test("계정이 아예 없으면 인증 없이 붙는 설정이다", () => {
  const result = loadMailConfig({
    [MAIL_ENV_KEYS.host]: "relay.example.test",
    [MAIL_ENV_KEYS.port]: "25",
    [MAIL_ENV_KEYS.from]: "DSS <no-reply@example.test>",
  });
  assert.ok(result.ok);
  assert.equal(result.config.user, null);
  assert.equal(result.config.password, null);
});

test("🔴 옛 TLS 는 정확히 \"true\" 일 때만 켜진다 — 오타가 조용히 완화로 이어지지 않게", () => {
  for (const 값 of ["TRUE", "true", " True "]) {
    const result = loadMailConfig({ ...제대로된설정, [MAIL_ENV_KEYS.legacyTls]: 값 });
    assert.ok(result.ok);
    assert.equal(result.config.legacyTls, true, `"${값}" 이 안 켜졌다`);
  }
  for (const 값 of ["1", "yes", "참", ""]) {
    const result = loadMailConfig({ ...제대로된설정, [MAIL_ENV_KEYS.legacyTls]: 값 });
    assert.ok(result.ok);
    assert.equal(result.config.legacyTls, false, `"${값}" 이 켜졌다`);
  }
});

test("🔴 진단 한 줄에 비밀번호가 들어가지 않는다 — 길이만 적는다", () => {
  const result = loadMailConfig(제대로된설정);
  assert.ok(result.ok);
  const 한줄 = describeMailConfig(result.config);

  assert.equal(한줄.includes("비밀번호가짜"), false, 한줄);
  assert.ok(한줄.includes("비밀번호 6자"), 한줄);
  assert.ok(한줄.includes("smtp.example.test:587"));
});
