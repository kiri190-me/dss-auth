import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVAL_MAIL_KINDS,
  approvalKindFieldName,
  approvalKindKey,
  diffSubmittedApprovalKinds,
  findApprovalMailKind,
  isApprovalMailKindEnabled,
} from "./kinds";

/**
 * 갈래 다섯과 「켜짐」을 읽는 규칙.
 *
 * 🔴 이 파일이 지키는 가장 중요한 것은 **기본값이 「전부 끔」**이라는 것이다.
 * 반대로 틀리면 표를 만들자마자 전 직원에게 메일이 쏟아지고, 이미 나간 메일은
 * 회수할 수 없다.
 */

/** 폼 한 벌을 만든다. 🔵 체크한 칸만 실린다 — 브라우저가 그렇게 보낸다. */
function formWith(checked: readonly { clientId: string; kind: string }[]): FormData {
  const form = new FormData();
  for (const entry of checked) {
    form.append(approvalKindFieldName(entry.clientId, entry.kind), "on");
  }
  return form;
}

test("갈래가 다섯이고, 세 시스템의 코드와 글자가 맞는다", () => {
  // 🔴 저장소가 셋이라 컴파일러가 못 잡는 자리다. 저쪽 코드를 고치면 이 줄이 먼저
  //    깨져야 한다(approvals/kinds.ts 머리말).
  assert.deepEqual(
    APPROVAL_MAIL_KINDS.map((entry) => `${entry.clientId}:${entry.kind}`),
    [
      "rf-service-system:REPAIR_INSPECTION",
      "rf-service-system:FINAL_SHIPMENT",
      "rf-service-system:QUOTE_APPROVAL",
      "dss-inventory:PART_ISSUE_APPROVAL",
      "dss-leave:LEAVE_REQUEST",
    ]
  );
});

test("갈래마다 사람이 읽는 이름이 있다 — 메일 본문에 쓰는 유일한 말이다", () => {
  assert.equal(APPROVAL_MAIL_KINDS.length, 5);
  for (const entry of APPROVAL_MAIL_KINDS) {
    assert.ok(entry.label.trim() !== "", `${entry.kind} 에 이름이 없다`);
    assert.ok(entry.systemLabel.trim() !== "", `${entry.kind} 에 시스템 이름이 없다`);
  }
});

test("🔴 기본값은 전부 끔 — 저장된 것이 없으면 다섯 다 꺼져 있다", () => {
  const nothingStored = new Set<string>();
  // 🔵 먼저 「무엇을 재는지」를 못 박는다. 목록이 비면 아래 for 가 공짜로 통과한다.
  assert.equal(APPROVAL_MAIL_KINDS.length, 5);
  for (const entry of APPROVAL_MAIL_KINDS) {
    assert.equal(
      isApprovalMailKindEnabled(nothingStored, entry.clientId, entry.kind),
      false,
      `${entry.kind} 이 기본으로 켜져 있다`
    );
  }
});

test("켜 둔 갈래만 켜진 것으로 읽는다", () => {
  const enabled = new Set([approvalKindKey("dss-leave", "LEAVE_REQUEST")]);
  assert.equal(isApprovalMailKindEnabled(enabled, "dss-leave", "LEAVE_REQUEST"), true);
  assert.equal(isApprovalMailKindEnabled(enabled, "dss-inventory", "PART_ISSUE_APPROVAL"), false);
  // 🔴 시스템이 다르면 다른 스위치다. 갈래 코드만 같다고 켜지면 안 된다.
  assert.equal(isApprovalMailKindEnabled(enabled, "rf-service-system", "LEAVE_REQUEST"), false);
});

test("모르는 갈래는 알아보지 못하고, 켜질 수도 없다", () => {
  assert.equal(findApprovalMailKind("dss-leave", "SOMETHING_NEW"), undefined);
  assert.equal(findApprovalMailKind("dss-board", "LEAVE_REQUEST"), undefined);
  const enabled = new Set([approvalKindKey("dss-leave", "SOMETHING_NEW")]);
  // 집합에 들어 있어도 갈래 표에 없으면 보낼 것을 고를 때 빠진다(plan.ts).
  assert.equal(findApprovalMailKind("dss-leave", "SOMETHING_NEW"), undefined);
  assert.equal(isApprovalMailKindEnabled(enabled, "dss-leave", "SOMETHING_NEW"), true);
});

test("바뀐 스위치만 골라낸다 — 아무것도 안 건드렸으면 0개다", () => {
  const enabled = new Set([approvalKindKey("dss-leave", "LEAVE_REQUEST")]);
  const changes = diffSubmittedApprovalKinds({
    form: formWith([{ clientId: "dss-leave", kind: "LEAVE_REQUEST" }]),
    enabledKeys: enabled,
  });
  assert.deepEqual(changes, []);
});

test("체크를 더하면 켜는 줄 하나가 나온다", () => {
  const changes = diffSubmittedApprovalKinds({
    form: formWith([{ clientId: "dss-inventory", kind: "PART_ISSUE_APPROVAL" }]),
    enabledKeys: new Set(),
  });
  assert.deepEqual(changes, [
    { clientId: "dss-inventory", kind: "PART_ISSUE_APPROVAL", enabled: true },
  ]);
});

test("🔴 체크를 지우면 끄는 줄이 나온다 — 「안 실림」은 「모름」이 아니라 「끔」이다", () => {
  // 브라우저는 체크를 푼 칸을 **아예 보내지 않는다.** 이것을 「모름」으로 읽으면
  // 끄는 일이 영영 저장되지 않는다.
  const changes = diffSubmittedApprovalKinds({
    form: new FormData(),
    enabledKeys: new Set([
      approvalKindKey("dss-leave", "LEAVE_REQUEST"),
      approvalKindKey("rf-service-system", "QUOTE_APPROVAL"),
    ]),
  });
  assert.deepEqual(changes, [
    { clientId: "rf-service-system", kind: "QUOTE_APPROVAL", enabled: false },
    { clientId: "dss-leave", kind: "LEAVE_REQUEST", enabled: false },
  ]);
});

test("폼에 들어온 모르는 칸은 쳐다보지 않는다", () => {
  const form = new FormData();
  form.append("approval-mail:dss-board:SOMETHING", "on");
  assert.deepEqual(diffSubmittedApprovalKinds({ form, enabledKeys: new Set() }), []);
});

test("칸 이름과 열쇠 글자", () => {
  assert.equal(approvalKindKey("dss-leave", "LEAVE_REQUEST"), "dss-leave:LEAVE_REQUEST");
  assert.equal(
    approvalKindFieldName("dss-leave", "LEAVE_REQUEST"),
    "approval-mail:dss-leave:LEAVE_REQUEST"
  );
});
