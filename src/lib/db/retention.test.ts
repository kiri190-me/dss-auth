import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCESS_TOKEN_RETENTION_DAYS,
  AUDIT_LOG_RETENTION_DAYS,
  AUTHORIZATION_CODE_RETENTION_DAYS,
  retentionCutoffs,
  SSO_SESSION_RETENTION_DAYS,
} from "./retention";

const NOW = new Date("2026-08-27T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

test("기준 시각에서 정해진 일수만큼 거슬러 올라간다", () => {
  const cut = retentionCutoffs(NOW);
  assert.equal(
    cut.authorizationCodes.getTime(),
    NOW.getTime() - AUTHORIZATION_CODE_RETENTION_DAYS * DAY_MS
  );
  assert.equal(
    cut.accessTokens.getTime(),
    NOW.getTime() - ACCESS_TOKEN_RETENTION_DAYS * DAY_MS
  );
  assert.equal(
    cut.ssoSessions.getTime(),
    NOW.getTime() - SSO_SESSION_RETENTION_DAYS * DAY_MS
  );
  assert.equal(
    cut.auditLogs.getTime(),
    NOW.getTime() - AUDIT_LOG_RETENTION_DAYS * DAY_MS
  );
});

test("인가 코드를 만료 즉시 지우지 않는다", () => {
  // consumedAt이 남아 있어야 재사용 공격과 오타를 구분할 수 있다. 이 값이
  // 0이 되면 그 구분이 사라진다.
  assert.ok(AUTHORIZATION_CODE_RETENTION_DAYS >= 7);
});

test("코드와 토큰은 같은 기간을 쓴다", () => {
  // 코드 재사용 → 토큰 폐기는 하나의 사건이 두 표에 남는 것이라, 한쪽만
  // 먼저 사라지면 사건이 반쪽만 남는다.
  assert.equal(AUTHORIZATION_CODE_RETENTION_DAYS, ACCESS_TOKEN_RETENTION_DAYS);
});

test("세션은 코드·토큰보다 오래 남긴다", () => {
  assert.ok(SSO_SESSION_RETENTION_DAYS > AUTHORIZATION_CODE_RETENTION_DAYS);
});

test("감사 로그가 가장 오래 남고, 3년이다", () => {
  assert.equal(AUDIT_LOG_RETENTION_DAYS, 365 * 3);
  assert.ok(AUDIT_LOG_RETENTION_DAYS > SSO_SESSION_RETENTION_DAYS);
});

test("모든 기준 시각이 지금보다 과거다", () => {
  // 부호를 뒤집으면 미래를 자르게 되고, 그러면 방금 만든 행부터 지워진다.
  for (const [name, cutoff] of Object.entries(retentionCutoffs(NOW))) {
    assert.ok(cutoff.getTime() < NOW.getTime(), name);
  }
});

test("기준 시각이 바뀌면 잘라내는 지점도 함께 움직인다", () => {
  const later = new Date(NOW.getTime() + 10 * DAY_MS);
  assert.equal(
    retentionCutoffs(later).auditLogs.getTime() -
      retentionCutoffs(NOW).auditLogs.getTime(),
    10 * DAY_MS
  );
});
