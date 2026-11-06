import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatheredApprovalItem } from "./gather";
import { approvalKindKey } from "./kinds";
import { approvalDeliveryKey, selectApprovalsToMail } from "./plan";

/**
 * 「무엇을 메일로 알릴 것인가」.
 *
 * 🔴 여기서 틀리면 둘 중 하나가 된다: 같은 메일이 날마다 가거나(이미 보낸 건을
 * 안 빼면), 꺼 둔 갈래의 메일이 나간다. 둘 다 사람이 신고하기 전에는 안 보인다.
 */

const LEAVE = approvalKindKey("dss-leave", "LEAVE_REQUEST");
const PART = approvalKindKey("dss-inventory", "PART_ISSUE_APPROVAL");

function item(clientId: string, kind: string, id: string): GatheredApprovalItem {
  return { clientId, kind, id };
}

const LEAVE_1 = item("dss-leave", "LEAVE_REQUEST", "LEAVE_REQUEST:1");
const LEAVE_2 = item("dss-leave", "LEAVE_REQUEST", "LEAVE_REQUEST:2");
const PART_1 = item("dss-inventory", "PART_ISSUE_APPROVAL", "PART_ISSUE_APPROVAL:1");

test("켜 둔 갈래의 아직 안 보낸 건만 고른다", () => {
  const selection = selectApprovalsToMail({
    items: [LEAVE_1, PART_1],
    enabledKeys: new Set([LEAVE, PART]),
    alreadySent: new Set(),
  });

  assert.deepEqual(selection.toSend, [LEAVE_1, PART_1]);
  assert.equal(selection.skippedDisabled, 0);
  assert.equal(selection.skippedAlreadySent, 0);
});

test("🔴 꺼 둔 갈래는 보내지 않는다 — 그리고 몇 건을 뺐는지 센다", () => {
  const selection = selectApprovalsToMail({
    items: [LEAVE_1, LEAVE_2, PART_1],
    enabledKeys: new Set([PART]),
    alreadySent: new Set(),
  });

  assert.deepEqual(selection.toSend, [PART_1]);
  assert.equal(selection.skippedDisabled, 2);
});

test("🔴 기본값이 전부 끔이면 한 건도 안 나간다", () => {
  const selection = selectApprovalsToMail({
    items: [LEAVE_1, LEAVE_2, PART_1],
    enabledKeys: new Set(),
    alreadySent: new Set(),
  });

  assert.deepEqual(selection.toSend, []);
  assert.equal(selection.skippedDisabled, 3);
});

test("🔴 이미 보낸 건은 두 번 보내지 않는다", () => {
  const selection = selectApprovalsToMail({
    items: [LEAVE_1, LEAVE_2],
    enabledKeys: new Set([LEAVE]),
    alreadySent: new Set([approvalDeliveryKey("dss-leave", "LEAVE_REQUEST:1")]),
  });

  assert.deepEqual(selection.toSend, [LEAVE_2]);
  assert.equal(selection.skippedAlreadySent, 1);
});

test("보낸 기록의 열쇠는 시스템까지 함께 본다 — 다른 시스템의 같은 id 는 다른 건이다", () => {
  const selection = selectApprovalsToMail({
    items: [item("dss-leave", "LEAVE_REQUEST", "1")],
    enabledKeys: new Set([LEAVE]),
    // 재고 쪽에서 "1" 을 보낸 적이 있어도 휴가의 "1" 과는 다른 건이다.
    alreadySent: new Set([approvalDeliveryKey("dss-inventory", "1")]),
  });
  assert.equal(selection.toSend.length, 1);
  assert.equal(selection.skippedAlreadySent, 0);
});

test("🔴 포털이 모르는 갈래는 빼되 그 수를 센다 — 0 이 아니면 갈래 표에 한 줄 더할 때다", () => {
  const selection = selectApprovalsToMail({
    items: [item("dss-leave", "SOMETHING_NEW", "X:1"), LEAVE_1],
    enabledKeys: new Set([LEAVE, approvalKindKey("dss-leave", "SOMETHING_NEW")]),
    alreadySent: new Set(),
  });

  assert.deepEqual(selection.toSend, [LEAVE_1]);
  assert.equal(selection.skippedUnknownKind, 1);
  assert.equal(selection.skippedDisabled, 0);
});

test("🔴 기타건 최종 출하 결재는 **모르는 갈래가 아니다** — 켜면 메일이 나간다", () => {
  // 2026-11-06 에 A/S 가 낸 새 갈래다. 갈래 표에 한 줄이 없으면 위 시험이 재는
  // `skippedUnknownKind` 로 떨어져 **켜 두어도 한 통도 안 나간다** — 그 사실은
  // 작업 기록의 숫자 하나로만 남는다(kinds.ts 머리말).
  const misc = item(
    "rf-service-system",
    "DOMESTIC_ORDER_FINAL_SHIPMENT",
    "DOMESTIC_ORDER_FINAL_SHIPMENT:DO-1"
  );
  const kindKey = approvalKindKey("rf-service-system", "DOMESTIC_ORDER_FINAL_SHIPMENT");

  const on = selectApprovalsToMail({
    items: [misc],
    enabledKeys: new Set([kindKey]),
    alreadySent: new Set(),
  });
  assert.deepEqual(on.toSend, [misc]);
  assert.equal(on.skippedUnknownKind, 0);

  // 🔴 그리고 **끈 상태에서는 「꺼짐」으로 빠진다** — 「모름」이 아니다. 둘이
  //    뒤바뀌면 관리자가 켜도 아무 일이 안 일어나는데 기록은 멀쩡해 보인다.
  const off = selectApprovalsToMail({
    items: [misc],
    enabledKeys: new Set(),
    alreadySent: new Set(),
  });
  assert.deepEqual(off.toSend, []);
  assert.equal(off.skippedUnknownKind, 0);
  assert.equal(off.skippedDisabled, 1);
});

test("🔴 같은 열쇠가 두 번 오면 한 번만 싣는다 — 기록 한 문장이 통째로 실패한다", () => {
  const selection = selectApprovalsToMail({
    items: [LEAVE_1, LEAVE_1],
    enabledKeys: new Set([LEAVE]),
    alreadySent: new Set(),
  });

  assert.deepEqual(selection.toSend, [LEAVE_1]);
  assert.equal(selection.skippedDuplicate, 1);
});

test("열쇠 글자 — 붙이기만 하고 가르지 않는다", () => {
  assert.equal(
    approvalDeliveryKey("rf-service-system", "REPAIR_CASE_APPROVAL:abc:FINAL_SHIPMENT"),
    "rf-service-system:REPAIR_CASE_APPROVAL:abc:FINAL_SHIPMENT"
  );
});
