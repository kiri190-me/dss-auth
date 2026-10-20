import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCESS_TOKEN_RETENTION_DAYS,
  AUDIT_LOG_RETENTION_DAYS,
  AUTHORIZATION_CODE_RETENTION_DAYS,
  NOTIFICATION_DISMISSAL_RETENTION_DAYS,
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

test("알림 지움 표시의 경계가 기준 시각의 하루 전이다", () => {
  assert.equal(NOTIFICATION_DISMISSAL_RETENTION_DAYS, 1);
  assert.equal(
    retentionCutoffs(NOW).notificationDismissals.getTime(),
    NOW.getTime() - NOTIFICATION_DISMISSAL_RETENTION_DAYS * DAY_MS
  );
});

test("지움 표시가 다섯 중 가장 짧게 남는다", () => {
  // 나머지 넷은 나중에 조사하려고 남기는 기록이라 길수록 안전하지만, 지움은
  // 조사할 것이 없는 임시 표시다. 이 값이 다른 것만큼 길어지면 「숨겨도 하루
  // 안에 저절로 돌아온다」가 거짓이 된다 — 쓰기 통로가 사칭 위험을 받아들인
  // 근거가 그 한 문장이었다(설계안 5절 ③).
  for (const other of [
    AUTHORIZATION_CODE_RETENTION_DAYS,
    ACCESS_TOKEN_RETENTION_DAYS,
    SSO_SESSION_RETENTION_DAYS,
    AUDIT_LOG_RETENTION_DAYS,
  ]) {
    assert.ok(NOTIFICATION_DISMISSAL_RETENTION_DAYS < other);
  }
});

test("포털 세션의 절대 만료(12시간)보다는 길다", () => {
  // 세션이 아직 살아 있는데 표시가 먼저 걷히면 「안 지웠는데 다시 뜬다」가
  // 된다. 그래서 아래로는 12시간이 바닥이다.
  //
  // 12시간을 여기 적어 둔 까닭: 원본인 session/sso-session.ts의
  // SSO_SESSION_MAX_AGE_SECONDS는 server-only 파일이라 이 테스트에서 불러올 수
  // 없다. 값이 바뀌면 이 줄이 따라오지 않으므로, 세션 수명을 늘리는 사람이
  // 보도록 그 파일 쪽에도 보관 기간을 가리키는 말을 남겨 두는 편이 좋다.
  const SSO_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
  assert.ok(
    NOTIFICATION_DISMISSAL_RETENTION_DAYS * DAY_MS > SSO_SESSION_MAX_AGE_MS
  );
});

test("기준 시각이 바뀌면 잘라내는 지점도 함께 움직인다", () => {
  const later = new Date(NOW.getTime() + 10 * DAY_MS);
  assert.equal(
    retentionCutoffs(later).auditLogs.getTime() -
      retentionCutoffs(NOW).auditLogs.getTime(),
    10 * DAY_MS
  );
});
