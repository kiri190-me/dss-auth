import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApprovalInbox } from "./inbox";

/**
 * 🔴 **이 저장소에서 가장 중요한 울타리 가운데 하나.**
 *
 * 메일 본문에 결재의 내용을 싣지 않기로 했는데(2026-10-23), 그 약속을 지키는
 * 방법이 「본문을 만들 때 조심한다」가 아니라 **「내용을 아예 들여오지 않는다」**
 * 이다. 이 파일은 그것을 잰다 — 저쪽이 일곱 칸을 보내도 포털에 남는 것은 둘이다.
 */

/** 세 시스템이 실제로 보내는 모양 한 줄. 🔵 값은 전부 가짜다. */
const FULL_ROW = {
  id: "QUOTE_APPROVAL:9f1c",
  kind: "QUOTE_APPROVAL",
  kindLabel: "견적서 결재",
  subject: "Q-2026-0101",
  detail: "결재선 2단계 · 요청자 홍길동",
  requestedAt: "2026-10-22T01:02:03.000Z",
  href: "http://as.test/quotes/9f1c/approval",
};

test("🔴 들여오는 칸은 id 와 kind 둘뿐이다 — 나머지 다섯은 포털에 남지 않는다", () => {
  const parsed = parseApprovalInbox({ items: [FULL_ROW], count: 1 });
  assert.ok(parsed !== null);
  assert.equal(parsed.items.length, 1);

  // 🔴 칸 이름을 통째로 잰다. `...raw` 로 펼치는 순간 이 줄이 깨진다.
  assert.deepEqual(Object.keys(parsed.items[0]).sort(), ["id", "kind"]);
  assert.deepEqual(parsed.items[0], { id: "QUOTE_APPROVAL:9f1c", kind: "QUOTE_APPROVAL" });

  // 🔵 글자로도 한 번 더 — 어떤 칸 이름으로든 내용이 딸려 오면 걸린다.
  const dump = JSON.stringify(parsed);
  for (const forbidden of [FULL_ROW.kindLabel, FULL_ROW.subject, FULL_ROW.detail, FULL_ROW.href]) {
    assert.equal(dump.includes(forbidden), false, `"${forbidden}" 이 포털로 들어왔다`);
  }
});

test("빈 목록은 정상이다 — 결재할 것이 없는 사람이 대부분이다", () => {
  assert.deepEqual(parseApprovalInbox({ items: [], count: 0 }), { items: [] });
});

test("🔴 「물어볼 수 없다」는 사정을 담아 올린다 — 「결재가 없다」와 다른 일이다", () => {
  const parsed = parseApprovalInbox({
    items: [],
    count: 0,
    unavailable: "employee_not_linked",
  });
  assert.deepEqual(parsed, { items: [], unavailable: "employee_not_linked" });
});

test("모르는 사정 글자도 그대로 담는다 — 포털을 고치지 않아도 기록에 남게", () => {
  const parsed = parseApprovalInbox({ items: [], count: 0, unavailable: "뭔가_새로운_사정" });
  assert.equal(parsed?.unavailable, "뭔가_새로운_사정");
});

test("줄 하나가 깨졌으면 그 줄만 버린다 — 나머지 메일까지 멎으면 손해가 더 크다", () => {
  const parsed = parseApprovalInbox({
    items: [
      FULL_ROW,
      { id: "", kind: "LEAVE_REQUEST" },
      { kind: "LEAVE_REQUEST" },
      { id: "LEAVE_REQUEST:1" },
      "줄이 아님",
      null,
      { id: "LEAVE_REQUEST:2", kind: "LEAVE_REQUEST" },
    ],
    count: 7,
  });

  assert.deepEqual(parsed?.items, [
    { id: "QUOTE_APPROVAL:9f1c", kind: "QUOTE_APPROVAL" },
    { id: "LEAVE_REQUEST:2", kind: "LEAVE_REQUEST" },
  ]);
});

test("모양이 아예 다르면 null — 「없다」로 읽으면 그 시스템 메일이 조용히 멎는다", () => {
  assert.equal(parseApprovalInbox(null), null);
  assert.equal(parseApprovalInbox("응답아님"), null);
  assert.equal(parseApprovalInbox({ count: 0 }), null);
  assert.equal(parseApprovalInbox({ items: "목록아님" }), null);
  assert.equal(parseApprovalInbox({ error: "invalid_token" }), null);
});
