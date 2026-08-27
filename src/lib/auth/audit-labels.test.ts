import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUDIT_LABELS,
  auditLabel,
  auditSummary,
  isNotable,
  type AuditAction,
} from "./audit-labels";

test("모든 감사 유형에 우리말 이름이 있다", () => {
  // enum에 값을 더하고 여기 이름을 잊으면 화면에 영문 코드가 그대로 뜬다.
  for (const [action, label] of Object.entries(AUDIT_LABELS)) {
    assert.ok(label.length > 0, action);
    assert.notEqual(label, action, `${action}에 우리말 이름이 없다`);
  }
});

test("역할 변경은 반드시 주목 대상이다", () => {
  // 이 한 줄이 누군가를 A/S 최고관리자로 만들 수 있다. 이 화면을 만든
  // 가장 큰 이유이므로 테스트로 못 박는다.
  assert.equal(isNotable("GRANT_ROLE_CHANGED"), true);
});

test("일상 활동은 주목 대상이 아니다", () => {
  // 하루에 수십 건 쌓이는 것을 강조하면 진짜 신호가 그 속에 묻힌다.
  for (const action of ["LOGIN_SUCCESS", "LOGOUT", "TOKEN_ISSUED"] as AuditAction[]) {
    assert.equal(isNotable(action), false, action);
  }
});

test("보안 신호는 전부 주목 대상이다", () => {
  const mustBeNotable: AuditAction[] = [
    "EMERGENCY_LOGIN",
    "CODE_REPLAY_DETECTED",
    "USER_SUSPENDED",
    "KEY_ROTATED",
    "CLIENT_SECRET_ROTATED",
    "GRANT_ADDED",
    "GRANT_REMOVED",
    "LOGIN_FAILED",
  ];
  for (const action of mustBeNotable) {
    assert.equal(isNotable(action), true, action);
  }
});

test("역할 변경 요약은 이전과 이후를 함께 보여준다", () => {
  assert.equal(
    auditSummary({
      actionType: "GRANT_ROLE_CHANGED",
      previousValue: { role: "SALES" },
      newValue: { role: "SUPER_ADMIN", displayName: "최희만" },
      clientId: "rf-service-system",
    }),
    "최희만 · SALES → SUPER_ADMIN"
  );
});

test("이전 역할이 없던 경우도 읽히게 적는다", () => {
  assert.equal(
    auditSummary({
      actionType: "GRANT_ROLE_CHANGED",
      previousValue: { role: null },
      newValue: { role: "SUPER_ADMIN", displayName: "최희만" },
      clientId: "rf-service-system",
    }),
    "최희만 · (없음) → SUPER_ADMIN"
  );
});

test("권한 부여는 사람과 역할을 함께 보여준다", () => {
  assert.equal(
    auditSummary({
      actionType: "GRANT_ADDED",
      previousValue: null,
      newValue: { displayName: "이남준", role: "AS_ENGINEER" },
      clientId: "rf-service-system",
    }),
    "이남준 · AS_ENGINEER"
  );
  // 역할 개념이 생기기 전에 부여된 건은 역할이 없다.
  assert.equal(
    auditSummary({
      actionType: "GRANT_ADDED",
      previousValue: null,
      newValue: { displayName: "이남준", role: null },
      clientId: "rf-service-system",
    }),
    "이남준"
  );
});

test("실패 사유를 그대로 옮긴다", () => {
  assert.equal(
    auditSummary({
      actionType: "LOGIN_FAILED",
      previousValue: null,
      newValue: { reason: "LOCKED", via: "EMERGENCY" },
      clientId: null,
    }),
    "EMERGENCY · LOCKED"
  );
});

test("첫 로그인을 표시한다", () => {
  assert.equal(
    auditSummary({
      actionType: "LOGIN_SUCCESS",
      previousValue: null,
      newValue: { method: "KAKAO", isNewUser: true },
      clientId: null,
    }),
    "KAKAO · 첫 로그인"
  );
  assert.equal(
    auditSummary({
      actionType: "LOGIN_SUCCESS",
      previousValue: null,
      newValue: { method: "KAKAO", isNewUser: false },
      clientId: null,
    }),
    "KAKAO"
  );
});

test("값이 없거나 형이 이상해도 터지지 않는다", () => {
  // 감사 로그의 jsonb는 시간이 지나며 모양이 달라진다. 화면이 그것 때문에
  // 통째로 죽으면 정작 필요한 순간에 못 본다.
  for (const bad of [null, undefined, "문자열", 42, []]) {
    assert.doesNotThrow(() =>
      auditSummary({
        actionType: "GRANT_ROLE_CHANGED",
        previousValue: bad,
        newValue: bad,
        clientId: null,
      })
    );
  }
  assert.equal(
    auditSummary({
      actionType: "TOKEN_ISSUED",
      previousValue: null,
      newValue: null,
      clientId: "rf-service-system",
    }),
    null
  );
});

test("모르는 유형이 와도 이름 대신 코드라도 보여준다", () => {
  assert.equal(auditLabel("KEY_ROTATED"), "서명 키 교체");
  assert.equal(auditLabel("__UNKNOWN__" as AuditAction), "__UNKNOWN__");
});
