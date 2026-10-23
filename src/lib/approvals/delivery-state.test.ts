import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVAL_DELIVERY_FAILED,
  APPROVAL_DELIVERY_SENDING,
  APPROVAL_DELIVERY_SENT,
  APPROVAL_SENDING_LEASE_MS,
  countsAsSentApproval,
  sentApprovalKeysFrom,
} from "./delivery-state";

/**
 * ============================================================================
 * 🔴 「보내는 중」의 수명 — 이 숫자 하나로 두 가지가 갈린다
 * ============================================================================
 *  · 수명이 **너무 짧으면** 아직 보내는 중인 건을 주기 작업이 집어 **같은 메일이
 *    두 통** 간다.
 *  · 수명이 **아예 없으면**(= SENDING 을 늘 「보냈다」로 치면) 찍어 놓고 죽은 줄이
 *    **영영 안 나가고 아무도 신고하지 않는다.**
 *
 * 🔴 그래서 「언제까지 참인가」와 「언제부터 거짓인가」를 **둘 다** 잰다. 한쪽만
 * 재면 `return true` 한 줄로도 통과한다.
 * ============================================================================
 */

const AT = new Date("2026-10-24T09:00:00.000Z");

function ago(ms: number): Date {
  return new Date(AT.getTime() - ms);
}

test("🔴 `SENT` 는 아무리 오래돼도 「보냈다」다 — 같은 결재가 두 번 안 간다", () => {
  assert.equal(
    countsAsSentApproval({ status: APPROVAL_DELIVERY_SENT, sentAt: ago(400 * 24 * 3600_000) }, AT),
    true
  );
});

test("🔴 `FAILED` 는 방금 적힌 것이어도 「아직 안 보냄」이다 — 주기 작업이 다시 집는다", () => {
  assert.equal(countsAsSentApproval({ status: APPROVAL_DELIVERY_FAILED, sentAt: AT }, AT), false);
});

test("🔴 `SENDING` 은 수명 **안**에서만 「보냈다」다", () => {
  // 방금 찍었다 — 다른 요청도 주기 작업도 이 건을 건드리면 안 된다.
  assert.equal(countsAsSentApproval({ status: APPROVAL_DELIVERY_SENDING, sentAt: AT }, AT), true);
  assert.equal(
    countsAsSentApproval(
      { status: APPROVAL_DELIVERY_SENDING, sentAt: ago(APPROVAL_SENDING_LEASE_MS - 1) },
      AT
    ),
    true
  );
});

test("🔴 수명이 지난 `SENDING` 은 다시 「아직 안 보냄」이다 — 찍어 놓고 죽은 줄을 줍는다", () => {
  // 🔴 **딱 수명만큼** 지난 순간부터 거짓이다. claim 의 SQL 조건이
  //    `sent_at <= now() - 수명` 이라(mutations/approval-mail-claims.ts) 경계가
  //    같은 쪽으로 떨어져야 한다 — 어긋나면 「읽기는 보냈다는데 찍기는 덮는」
  //    1밀리초가 생긴다.
  assert.equal(
    countsAsSentApproval(
      { status: APPROVAL_DELIVERY_SENDING, sentAt: ago(APPROVAL_SENDING_LEASE_MS) },
      AT
    ),
    false
  );
  assert.equal(
    countsAsSentApproval(
      { status: APPROVAL_DELIVERY_SENDING, sentAt: ago(APPROVAL_SENDING_LEASE_MS + 1) },
      AT
    ),
    false
  );
});

test("🔴 모르는 글자는 「아직 안 보냄」쪽으로 떨어진다 — 놓치지 않는다", () => {
  // 표에 CHECK 가 없어 글자가 늘 수 있다(db/schema/approval-mail-deliveries.ts).
  // 모르는 글자를 「보냈다」로 읽으면 그 결재의 메일이 영영 안 나간다.
  for (const status of ["", "sent", "SENT_OK", "QUEUED", "보냄"]) {
    assert.equal(countsAsSentApproval({ status, sentAt: AT }, AT), false, status);
  }
});

test("🔴 수명은 **분 단위**다 — SMTP 한 통보다 넉넉하고, 사람이 눈치챌 만큼 길지 않다", () => {
  // 🔵 값 자체를 못 박지 않고 범위를 잰다. 1분보다 짧으면 느린 SMTP 왕복과
  //    겹치고, 1시간보다 길면 죽은 줄이 그만큼 묻힌다.
  assert.ok(APPROVAL_SENDING_LEASE_MS >= 60_000, "수명이 1분보다 짧다");
  assert.ok(APPROVAL_SENDING_LEASE_MS <= 3600_000, "수명이 1시간보다 길다");
});

test("섞인 줄에서 「이미 보낸 것」의 열쇠만 고른다", () => {
  const keys = sentApprovalKeysFrom(
    [
      { clientId: "rf-service-system", itemId: "A", status: APPROVAL_DELIVERY_SENT, sentAt: ago(1) },
      { clientId: "rf-service-system", itemId: "B", status: APPROVAL_DELIVERY_FAILED, sentAt: ago(1) },
      { clientId: "dss-leave", itemId: "C", status: APPROVAL_DELIVERY_SENDING, sentAt: ago(1) },
      {
        clientId: "dss-leave",
        itemId: "D",
        status: APPROVAL_DELIVERY_SENDING,
        sentAt: ago(APPROVAL_SENDING_LEASE_MS + 1),
      },
    ],
    AT
  );

  // 표본이 비지 않았는지 먼저 본다 — 넷 중 둘이 남아야 한다.
  assert.equal(keys.size, 2);
  assert.ok(keys.has("rf-service-system:A"));
  assert.ok(keys.has("dss-leave:C"));
  assert.equal(keys.has("rf-service-system:B"), false, "실패한 줄을 「보냈다」로 셌다");
  assert.equal(keys.has("dss-leave:D"), false, "수명이 지난 SENDING 을 「보냈다」로 셌다");
});

test("🔴 결재건 id 에 `:` 가 들어 있어도 열쇠가 섞이지 않는다", () => {
  // A/S 의 id 가 그렇다: `REPAIR_CASE_APPROVAL:…:FINAL_SHIPMENT`.
  const keys = sentApprovalKeysFrom(
    [
      {
        clientId: "rf-service-system",
        itemId: "REPAIR_CASE_APPROVAL:7:FINAL_SHIPMENT",
        status: APPROVAL_DELIVERY_SENT,
        sentAt: AT,
      },
    ],
    AT
  );
  assert.ok(keys.has("rf-service-system:REPAIR_CASE_APPROVAL:7:FINAL_SHIPMENT"));
});
