import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareApprovalHistoryNewestFirst,
  parsePortalApprovalHistory,
  PORTAL_APPROVAL_HISTORY_RELATIONS,
  type PortalApprovalHistoryEntry,
} from "./history-entry";
import { screenApprovalKey } from "./screen-inbox";

/**
 * ============================================================================
 * 내역 한 줄 읽기 — 🔴 **네 값을 다 받을 준비가 돼 있는가**
 * ============================================================================
 * 이 파일이 지키는 것:
 *  · `relation` **넷을 다 받는다.** A/S 는 `UNKNOWN` 을 안 내지만 재고관리와
 *    휴가는 낸다 — 셋만 처리하면 그 두 집의 옛 줄이 조용히 떨어진다.
 *  · 포털이 붙이는 셋(`key`·`sourceId`·`sourceName`)이 줄마다 선다.
 *  · 🔴 **버리는 줄은 정직하게 그릴 수 없는 둘뿐**이고, 버린 수가 올라간다.
 *  · 합치면 **새것부터** 선다.
 *
 * 🔴 **값은 전부 가짜다.**
 * ============================================================================
 */

const AS = { clientId: "rf-service-system", name: "A/S 관리" };
const LEAVE = { clientId: "dss-leave", name: "휴가 관리" };

/** 🔴 값은 전부 가짜다. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: "REPAIR_CASE:aaaa-1111",
    subject: "TEST-0001",
    approvalName: "수리 검수 승인",
    decidedAt: "2026-11-03T04:05:06.000Z",
    decision: "APPROVED",
    relation: "SELF",
    counterpartName: null,
    href: "http://as.test:3000/repair-cases/aaaa-1111",
    ...over,
  };
}

function parsed(body: unknown, source = AS) {
  const result = parsePortalApprovalHistory(body, source);
  assert.notEqual(result, null, "모양이 다르다고 읽었다");
  assert.ok(result);
  return result;
}

/* ───────────────────────────────── 먼저: 무엇을 재는지 */

test("🔵 표본이 비어서 공짜로 통과하지 않는다 — 한 줄이 실제로 올라온다", () => {
  const result = parsed({ entries: [row()] });
  assert.equal(result.entries.length, 1);
  assert.equal(result.dropped, 0);
  assert.equal(result.entries[0].subject, "TEST-0001");
});

/* ───────────────────────────────── 포털이 붙이는 셋 */

test("🔴 포털이 셋을 붙인다 — 각 집은 제 이름도, 남의 집 id 와 겹치는지도 모른다", () => {
  const fromAs = parsed({ entries: [row({ id: "X-1" })] }, AS);
  const fromLeave = parsed({ entries: [row({ id: "X-1" })] }, LEAVE);

  assert.equal(fromAs.entries[0].sourceId, "rf-service-system");
  assert.equal(fromAs.entries[0].sourceName, "A/S 관리");
  assert.equal(fromLeave.entries[0].sourceName, "휴가 관리");

  // 🔴 같은 id 라도 열쇠가 갈린다. 안 갈리면 승인함이 줄을 잘못 지운다.
  assert.notEqual(fromAs.entries[0].key, fromLeave.entries[0].key);
});

test("🔴 열쇠 꼴이 결재함과 같다 — 베끼지 않고 그 함수를 부른다", () => {
  const result = parsed({ entries: [row({ id: "QUOTE:bbb" })] }, AS);
  assert.equal(result.entries[0].key, screenApprovalKey("rf-service-system", "QUOTE:bbb"));
  assert.equal(result.entries[0].key, "rf-service-system:QUOTE:bbb");
});

test("🔴 저쪽이 제 이름을 적어 보내도 쓰지 않는다 — `clients` 표의 이름이 이긴다", () => {
  const result = parsed({ entries: [row({ sourceName: "남의 집", sourceId: "dss-po" })] }, AS);
  assert.equal(result.entries[0].sourceName, "A/S 관리");
  assert.equal(result.entries[0].sourceId, "rf-service-system");
});

/* ───────────────────────────────── relation 넷 */

test("🔴 `relation` 네 값을 **그대로** 받는다 — 셋만 처리하면 두 집의 옛 줄이 떨어진다", () => {
  assert.deepEqual([...PORTAL_APPROVAL_HISTORY_RELATIONS], [
    "SELF",
    "ON_BEHALF",
    "BY_DELEGATE",
    "UNKNOWN",
  ]);

  const result = parsed({
    entries: [
      row({ id: "1", relation: "SELF", counterpartName: null }),
      row({ id: "2", relation: "ON_BEHALF", counterpartName: "가짜 자리주인" }),
      row({ id: "3", relation: "BY_DELEGATE", counterpartName: "가짜 대리인" }),
      row({ id: "4", relation: "UNKNOWN", counterpartName: null }),
    ],
  });

  assert.equal(result.entries.length, 4);
  assert.deepEqual(
    result.entries.map((entry) => entry.relation),
    ["SELF", "ON_BEHALF", "BY_DELEGATE", "UNKNOWN"]
  );
  // 🔴 상대 이름이 갈래마다 다른 사람을 가리킨다 — 뒤바뀌면 「내가 나를 대신했다」가 된다.
  assert.equal(result.entries[1].counterpartName, "가짜 자리주인");
  assert.equal(result.entries[2].counterpartName, "가짜 대리인");
});

test("🔴 `UNKNOWN` 은 재고관리·휴가가 실제로 낸다 — 줄을 버리지 않는다", () => {
  const result = parsed({ entries: [row({ relation: "UNKNOWN", counterpartName: null })] }, LEAVE);
  assert.equal(result.dropped, 0);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].relation, "UNKNOWN");
});

test("모르는 `relation` 은 UNKNOWN 으로 접고 수를 센다 — 줄은 그려진다", () => {
  const result = parsed({ entries: [row({ relation: "DELEGATED_BY_ROBOT" })] });
  assert.equal(result.entries[0].relation, "UNKNOWN");
  assert.equal(result.unknownRelations, 1);
  assert.equal(result.dropped, 0);
});

test("🔴 상대가 없는 갈래 둘은 이름이 와도 null 로 닫는다 — 계약이 「상대 없음」이다", () => {
  const result = parsed({
    entries: [
      row({ id: "1", relation: "SELF", counterpartName: "가짜 이름" }),
      row({ id: "2", relation: "UNKNOWN", counterpartName: "가짜 이름" }),
    ],
  });
  assert.equal(result.entries[0].counterpartName, null);
  assert.equal(result.entries[1].counterpartName, null);
});

test("빈 이름은 null 이다 — 빈 글자를 올리면 화면이 「· 」 같은 자리만 그린다", () => {
  const result = parsed({ entries: [row({ relation: "BY_DELEGATE", counterpartName: "   " })] });
  assert.equal(result.entries[0].counterpartName, null);
});

/* ───────────────────────────────── 버리는 줄 둘 */

test("🔴 `id` 가 없으면 버린다 — 열쇠를 지을 수 없다", () => {
  const result = parsed({ entries: [row({ id: "" }), row({ id: 7 }), row({ id: "ok" })] });
  assert.equal(result.entries.length, 1);
  assert.equal(result.dropped, 2);
});

test("🔴 모르는 `decision` 은 버린다 — 기본값을 고르면 반려가 승인으로 그려진다", () => {
  const result = parsed({
    entries: [
      row({ id: "1", decision: "SKIPPED" }),
      row({ id: "2", decision: undefined }),
      row({ id: "3", decision: "REJECTED" }),
    ],
  });
  assert.equal(result.dropped, 2);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].decision, "REJECTED");
});

test("🔴 나머지 여섯 칸은 모양이 틀려도 버리지 않는다 — 날짜와 결정만으로도 뜻이 있다", () => {
  const result = parsed({
    entries: [row({ subject: 12, approvalName: null, decidedAt: {}, href: undefined })],
  });
  assert.equal(result.dropped, 0);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].subject, "");
  assert.equal(result.entries[0].approvalName, "");
  assert.equal(result.entries[0].decidedAt, "");
  assert.equal(result.entries[0].href, "");
});

/* ───────────────────────────────── 모양이 아예 다를 때 */

test("🔴 `entries` 가 없으면 null 이다 — 「내역이 없다」로 읽으면 그 집이 조용히 사라진다", () => {
  assert.equal(parsePortalApprovalHistory(null, AS), null);
  assert.equal(parsePortalApprovalHistory("", AS), null);
  assert.equal(parsePortalApprovalHistory({}, AS), null);
  // 🔴 결재함의 칸 이름(`items`)으로는 안 읽힌다 — 세 집이 `entries` 로 맞췄다.
  assert.equal(parsePortalApprovalHistory({ items: [] }, AS), null);
  // 줄이 없는 것은 정상이다.
  assert.deepEqual(parsePortalApprovalHistory({ entries: [] }, AS), {
    entries: [],
    dropped: 0,
    unknownRelations: 0,
  });
});

/* ───────────────────────────────── 차례 */

function entry(over: Partial<PortalApprovalHistoryEntry>): PortalApprovalHistoryEntry {
  return {
    key: "a:1",
    sourceId: "a",
    sourceName: "가짜 시스템",
    id: "1",
    subject: "",
    approvalName: "",
    decidedAt: "2026-11-01T00:00:00.000Z",
    decision: "APPROVED",
    relation: "SELF",
    counterpartName: null,
    href: "",
    ...over,
  };
}

test("🔴 합치면 새것부터 선다 — 집별로 뭉쳐 있으면 「내가 11월에 한 결재」가 아니다", () => {
  const merged = [
    entry({ key: "a:1", decidedAt: "2026-11-01T00:00:00.000Z" }),
    entry({ key: "a:2", decidedAt: "2026-11-30T00:00:00.000Z" }),
    entry({ key: "b:1", decidedAt: "2026-11-15T00:00:00.000Z" }),
  ].sort(compareApprovalHistoryNewestFirst);

  assert.deepEqual(
    merged.map((row) => row.key),
    ["a:2", "b:1", "a:1"]
  );
});

test("🔴 시간대 표기가 달라도 시간순으로 선다 — 글자 비교면 거꾸로 선다", () => {
  // 같은 순간을 두 꼴로 적은 것이 아니다: KST 09:00 이 UTC 00:00 보다 **이르다**.
  const kstLater = entry({ key: "a:kst", decidedAt: "2026-11-02T09:00:00+09:00" }); // = 00:00Z
  const utcLater = entry({ key: "b:utc", decidedAt: "2026-11-02T01:00:00.000Z" });

  const merged = [kstLater, utcLater].sort(compareApprovalHistoryNewestFirst);
  assert.deepEqual(
    merged.map((row) => row.key),
    ["b:utc", "a:kst"]
  );

  // 🔵 글자 비교였다면 "2026-11-02T09:00:00+09:00" 이 앞에 섰다 — 일부러 맞대어 본다.
  assert.ok("2026-11-02T09:00:00+09:00" > "2026-11-02T01:00:00.000Z");
});

test("같은 시각이면 열쇠로 동점을 깬다 — 새로고침마다 줄이 자리를 바꾸면 두 번 읽는다", () => {
  const same = "2026-11-02T01:00:00.000Z";
  const first = [
    entry({ key: "b:1", decidedAt: same }),
    entry({ key: "a:1", decidedAt: same }),
  ].sort(compareApprovalHistoryNewestFirst);
  const second = [
    entry({ key: "a:1", decidedAt: same }),
    entry({ key: "b:1", decidedAt: same }),
  ].sort(compareApprovalHistoryNewestFirst);

  assert.deepEqual(first.map((row) => row.key), ["a:1", "b:1"]);
  assert.deepEqual(second.map((row) => row.key), ["a:1", "b:1"]);
});

test("못 읽는 날짜는 맨 아래로 간다 — 버리지는 않는다", () => {
  const merged = [
    entry({ key: "a:bad", decidedAt: "" }),
    entry({ key: "b:1", decidedAt: "2026-11-01T00:00:00.000Z" }),
  ].sort(compareApprovalHistoryNewestFirst);

  assert.deepEqual(merged.map((row) => row.key), ["b:1", "a:bad"]);
  assert.equal(merged.length, 2);
});
