import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DELEGATION_LIST_ACTION,
  compareDelegations,
  delegationListRequestBody,
  delegationSyncFindings,
  delegationSyncUnmeasured,
  describeDelegationListFailure,
  readDelegationListReply,
  type DelegationComparison,
  type HouseDelegationEntry,
  type PortalDelegationSnapshot,
} from "./delegation-sync";

/**
 * 포털과 세 집의 결재권 위임 맞대어 보기 — **판정만** (설계 B-14 · C-9).
 *
 * 🔴 이 파일이 지키는 것 여섯:
 *  1. **200 이 아닌 답은 하나도 「집에 없다」가 되지 않는다.** 401·404·500·503·망 오류가
 *     전부 「못 쟀다」다. 하나라도 빈 목록으로 접히면 **그 집 위임이 통째로 어긋난 것으로
 *     보고**되고, 그 모양은 진짜 어긋남과 글자까지 같다.
 *  2. 🔴 **`truncated` 면 「포털에만 있다」를 한 줄도 말하지 않는다.**
 *  3. 🔴 **「집에만 있다」는 잘렸든 말든 어긋남이다** — 있는 줄은 확실히 있다.
 *  4. 🔴 **「포털에만 있다」는 어긋남이 아니다.** 양쪽 사람이 그 집에 들어갈 수 있는
 *     줄만 남기고, 그것도 「어긋남」이 아니라 **「설명 안 되는 것」**으로 센다.
 *  5. 🔵 **「포털은 안 거뒀는데 집은 거둬졌다」는 따로 센다** — 철회 전파를 되돌리지
 *     않기로 한 결정이 남기는 모양이라 설계대로일 수 있다. 🔴 그러나 기간까지 갈리면
 *     그것은 어긋남이다.
 *  6. 🔴 **시간대 없는 시각은 못 읽은 것으로 센다.** 지역 시각으로 읽히면 멀쩡한 줄이
 *     아홉 시간 어긋난 것으로 찍힌다.
 */

const ID_A = "11111111-0000-4000-8000-00000000000a";
const ID_B = "11111111-0000-4000-8000-00000000000b";
const ID_C = "11111111-0000-4000-8000-00000000000c";

const STARTS = "2026-11-10T00:00:00.000Z";
const ENDS = "2026-11-20T00:00:00.000Z";
const REVOKED = "2026-11-15T03:04:05.000Z";

/** 포털 줄 하나. 🔵 기본은 「양쪽 사람이 그 집에 들어갈 수 있다」 — 좁히기가 안 걸린 상태. */
function portalRow(
  id: string,
  over: Partial<PortalDelegationSnapshot> = {}
): PortalDelegationSnapshot {
  return {
    id,
    startsAt: new Date(STARTS),
    endsAt: new Date(ENDS),
    revokedAt: null,
    bothHaveAccess: true,
    ...over,
  };
}

function houseRow(id: string, over: Partial<HouseDelegationEntry> = {}): HouseDelegationEntry {
  return { id, startsAt: STARTS, endsAt: ENDS, revokedAt: null, ...over };
}

/** 🔵 표본이 비어서 공짜로 통과하는 일을 막는다 — 「무엇을 쟀나」를 먼저 센다. */
function assertSampleSizes(
  comparison: DelegationComparison,
  expected: { portal: number; house: number }
) {
  const portalSeen =
    comparison.matched.length +
    comparison.mismatched.length +
    comparison.revokedInHouseOnly.length +
    comparison.explainedPortalOnly.length +
    comparison.unexplainedPortalOnly.length +
    comparison.unmeasuredByTruncation.length +
    comparison.unreadable.length;
  assert.equal(portalSeen, expected.portal, "포털 줄이 하나도 빠짐없이 어딘가에 들어가야 한다");
  const houseSeen =
    comparison.matched.length +
    comparison.mismatched.length +
    comparison.revokedInHouseOnly.length +
    comparison.unreadable.length +
    comparison.houseOnly.length;
  assert.equal(houseSeen, expected.house, "집 줄이 하나도 빠짐없이 어딘가에 들어가야 한다");
}

/* ------------------------------------------------------------------ */
/* 보낼 몸통                                                            */
/* ------------------------------------------------------------------ */

test("보내는 몸통은 JSON 이고 action=list 하나뿐이다", () => {
  const body = delegationListRequestBody();
  assert.deepEqual(JSON.parse(body), { action: "list" });
  assert.equal(DELEGATION_LIST_ACTION, "list");
});

/* ------------------------------------------------------------------ */
/* 집의 답 읽기 — 🔴 200 이 아니면 전부 「못 쟀다」                        */
/* ------------------------------------------------------------------ */

test("정상 답을 읽는다 — 줄과 truncated 가 그대로 온다", () => {
  const answer = readDelegationListReply(200, {
    delegations: [{ id: ID_A, startsAt: STARTS, endsAt: ENDS, revokedAt: null }],
    truncated: false,
  });
  assert.equal(answer.ok, true);
  if (!answer.ok) return;
  assert.equal(answer.entries.length, 1);
  assert.equal(answer.entries[0].id, ID_A);
  assert.equal(answer.truncated, false);
});

test("🔴 200 이 아닌 답은 전부 실패다 — 빈 목록으로 접히지 않는다", () => {
  // 🔴 「없다」로 접히는 순간 그 집 위임이 통째로 어긋남이 된다.
  for (const [status, reason] of [
    [0, "unreachable"],
    [401, "invalid_token"],
    [404, "not_enabled"],
    [500, "storage_failed"],
    // 🔴 재고관리만 503 이다 — 뜻은 500 과 같다.
    [503, "storage_failed"],
    [400, "http_error"],
    [502, "http_error"],
  ] as const) {
    const answer = readDelegationListReply(status, { delegations: [], truncated: false });
    assert.equal(answer.ok, false, `status ${status} 가 성공으로 읽혔다`);
    if (answer.ok) continue;
    assert.equal(answer.reason, reason, `status ${status}`);
    // 🔵 까닭마다 사람에게 할 말이 있다(빈 글자면 출력이 침묵한다).
    assert.notEqual(describeDelegationListFailure(answer.reason), "");
  }
});

test("🔴 200 인데 모양이 다르면 실패다 — 「모름」을 「없음」으로 접지 않는다", () => {
  for (const body of [
    null,
    [],
    "문자열",
    {},
    { delegations: [] },
    { truncated: false },
    { delegations: {}, truncated: false },
    { delegations: [], truncated: "false" },
  ]) {
    const answer = readDelegationListReply(200, body);
    assert.equal(answer.ok, false, `${JSON.stringify(body)} 가 성공으로 읽혔다`);
    if (!answer.ok) assert.equal(answer.reason, "bad_shape");
  }
});

test("🔴 줄 하나가 모양이 아니면 몸통을 통째로 버린다 — 흘린 줄은 「집에 없다」가 된다", () => {
  const broken = readDelegationListReply(200, {
    delegations: [
      { id: ID_A, startsAt: STARTS, endsAt: ENDS, revokedAt: null },
      // 사람을 뺀 뒤 칸 이름을 잘못 적은 줄. 🔴 이 줄만 흘리면 ID_B 가 「집에 없다」가 된다.
      { id: ID_B, startsAt: STARTS, endsAt: ENDS, revoked_at: null },
    ],
    truncated: false,
  });
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.equal(broken.reason, "bad_shape");
});

test("🔵 revokedAt 은 널도 글자도 받는다 — 거둔 줄이 와야 맞대어 볼 수 있다", () => {
  const answer = readDelegationListReply(200, {
    delegations: [{ id: ID_A, startsAt: STARTS, endsAt: ENDS, revokedAt: REVOKED }],
    truncated: true,
  });
  assert.equal(answer.ok, true);
  if (!answer.ok) return;
  assert.equal(answer.entries[0].revokedAt, REVOKED);
  assert.equal(answer.truncated, true);
});

/* ------------------------------------------------------------------ */
/* 판정 ① 양쪽에 있고 같다                                              */
/* ------------------------------------------------------------------ */

test("양쪽에 있고 값이 같으면 통과다", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A), portalRow(ID_B, { revokedAt: new Date(REVOKED) })],
    house: [houseRow(ID_A), houseRow(ID_B, { revokedAt: REVOKED })],
    truncated: false,
  });
  assertSampleSizes(comparison, { portal: 2, house: 2 });
  assert.deepEqual(comparison.matched, [ID_A, ID_B]);
  assert.equal(delegationSyncFindings(comparison), 0);
  assert.equal(delegationSyncUnmeasured(comparison), 0);
});

test("🔵 글자가 달라도 같은 순간이면 통과다 — 오프셋 표기만 다른 경우", () => {
  const comparison = compareDelegations({
    // 2026-11-10T00:00:00Z == 2026-11-10T09:00:00+09:00
    portal: [portalRow(ID_A)],
    house: [houseRow(ID_A, { startsAt: "2026-11-10T09:00:00+09:00" })],
    truncated: false,
  });
  assertSampleSizes(comparison, { portal: 1, house: 1 });
  assert.deepEqual(comparison.matched, [ID_A]);
});

/* ------------------------------------------------------------------ */
/* 판정 ② 값이 다르다 — B-15 가 갈렸던 자리                              */
/* ------------------------------------------------------------------ */

test("🔴 기간이 다르면 어긋남이다 — 어느 칸이 어떻게 다른지까지 말한다", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A)],
    house: [houseRow(ID_A, { endsAt: "2026-11-21T00:00:00.000Z" })],
    truncated: false,
  });
  assertSampleSizes(comparison, { portal: 1, house: 1 });
  assert.equal(comparison.mismatched.length, 1);
  assert.equal(comparison.mismatched[0].id, ID_A);
  assert.deepEqual(comparison.mismatched[0].diffs, [
    { field: "endsAt", portal: ENDS, house: "2026-11-21T00:00:00.000Z" },
  ]);
  assert.equal(delegationSyncFindings(comparison), 1);
});

test("🔴 포털은 거뒀는데 집은 안 거뒀으면 어긋남이다 — 거둬지지 않은 결재권이 살아 있다", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A, { revokedAt: new Date(REVOKED) })],
    house: [houseRow(ID_A)],
    truncated: false,
  });
  assertSampleSizes(comparison, { portal: 1, house: 1 });
  assert.equal(comparison.revokedInHouseOnly.length, 0, "방향이 반대인데 설계대로로 접혔다");
  assert.equal(comparison.mismatched.length, 1);
  assert.deepEqual(comparison.mismatched[0].diffs, [
    { field: "revokedAt", portal: REVOKED, house: null },
  ]);
  assert.equal(delegationSyncFindings(comparison), 1);
});

test("🔴 거둔 시각이 서로 다르면 어긋남이다", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A, { revokedAt: new Date(REVOKED) })],
    house: [houseRow(ID_A, { revokedAt: "2026-11-16T03:04:05.000Z" })],
    truncated: false,
  });
  assert.equal(comparison.mismatched.length, 1);
  assert.equal(comparison.revokedInHouseOnly.length, 0);
});

/* ------------------------------------------------------------------ */
/* 🔵 포털은 안 거뒀는데 집은 거둬졌다 — 설계대로일 수 있다              */
/* ------------------------------------------------------------------ */

test("🔵 포털은 안 거뒀는데 집은 거둬졌으면 따로 센다 — 어긋남도 통과도 아니다", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A)],
    house: [houseRow(ID_A, { revokedAt: REVOKED })],
    truncated: false,
  });
  assertSampleSizes(comparison, { portal: 1, house: 1 });
  assert.equal(comparison.mismatched.length, 0, "설계대로일 수 있는 것을 어긋남으로 찍었다");
  assert.equal(comparison.matched.length, 0, "사람이 봐야 하는 것을 통과로 접었다");
  assert.equal(comparison.revokedInHouseOnly.length, 1);
  assert.equal(comparison.revokedInHouseOnly[0].id, ID_A);
  assert.equal(delegationSyncFindings(comparison), 0);
  assert.equal(delegationSyncUnmeasured(comparison), 1);
});

test("🔴 철회 방향이 같아도 기간까지 갈리면 어긋남이다", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A)],
    house: [houseRow(ID_A, { revokedAt: REVOKED, startsAt: "2026-11-11T00:00:00.000Z" })],
    truncated: false,
  });
  assert.equal(comparison.revokedInHouseOnly.length, 0, "기간이 갈린 줄이 눈감아졌다");
  assert.equal(comparison.mismatched.length, 1);
  assert.equal(comparison.mismatched[0].diffs.length, 2);
});

/* ------------------------------------------------------------------ */
/* 판정 ③ 집에만 있다 — 🔴 더 위험한 쪽                                  */
/* ------------------------------------------------------------------ */

test("🔴 집에만 있으면 어긋남이다 — 포털에서 거둔 줄 알았는데 살아 있는 경우", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A)],
    house: [houseRow(ID_A), houseRow(ID_B)],
    truncated: false,
  });
  assertSampleSizes(comparison, { portal: 1, house: 2 });
  assert.deepEqual(comparison.houseOnly, [ID_B]);
  assert.equal(delegationSyncFindings(comparison), 1);
});

test("🔴 잘린 답에서도 「집에만 있다」는 그대로 어긋남이다 — 있는 줄은 확실히 있다", () => {
  const comparison = compareDelegations({
    portal: [],
    house: [houseRow(ID_B)],
    truncated: true,
  });
  assertSampleSizes(comparison, { portal: 0, house: 1 });
  assert.deepEqual(comparison.houseOnly, [ID_B]);
  assert.equal(delegationSyncFindings(comparison), 1);
});

/* ------------------------------------------------------------------ */
/* 판정 ④ 포털에만 있다 — 🔴 어긋남으로 단정하지 않는다                   */
/* ------------------------------------------------------------------ */

test("🔴 포털에만 있는데 둘 중 하나가 그 집에 못 들어가면 「설명됨」이다", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A, { bothHaveAccess: false })],
    house: [],
    truncated: false,
  });
  assertSampleSizes(comparison, { portal: 1, house: 0 });
  assert.deepEqual(comparison.explainedPortalOnly, [ID_A]);
  assert.deepEqual(comparison.unexplainedPortalOnly, []);
  assert.equal(delegationSyncFindings(comparison), 0);
  // 🔴 설명된 것은 못 쟀다에도 안 들어간다 — 전파가 not_applicable 로 끝난 정상이다.
  assert.equal(delegationSyncUnmeasured(comparison), 0);
});

test("🔴 포털에만 있고 둘 다 그 집에 들어갈 수 있으면 — 어긋남이 아니라 「설명 안 되는 것」", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A)],
    house: [],
    truncated: false,
  });
  assertSampleSizes(comparison, { portal: 1, house: 0 });
  assert.deepEqual(comparison.unexplainedPortalOnly, [ID_A]);
  assert.equal(delegationSyncFindings(comparison), 0, "단정하면 안 되는 것을 어긋남으로 찍었다");
  assert.equal(delegationSyncUnmeasured(comparison), 1);
});

test("🔴 잘렸으면 「포털에만 있다」를 한 줄도 말하지 않는다", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A), portalRow(ID_B, { bothHaveAccess: false }), portalRow(ID_C)],
    house: [houseRow(ID_C)],
    truncated: true,
  });
  assertSampleSizes(comparison, { portal: 3, house: 1 });
  assert.deepEqual(comparison.unexplainedPortalOnly, []);
  assert.deepEqual(comparison.explainedPortalOnly, []);
  assert.deepEqual(comparison.unmeasuredByTruncation, [ID_A, ID_B]);
  assert.deepEqual(comparison.matched, [ID_C], "잘려도 온 줄은 그대로 맞대어 본다");
  assert.equal(delegationSyncFindings(comparison), 0);
  assert.equal(delegationSyncUnmeasured(comparison), 2);
});

/* ------------------------------------------------------------------ */
/* 🔴 시간대 없는 시각                                                   */
/* ------------------------------------------------------------------ */

test("🔴 시간대가 안 붙은 시각은 못 읽은 것으로 센다 — 아홉 시간 어긋난 거짓 어긋남을 막는다", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A)],
    house: [houseRow(ID_A, { startsAt: "2026-11-10T00:00:00" })],
    truncated: false,
  });
  assertSampleSizes(comparison, { portal: 1, house: 1 });
  assert.deepEqual(comparison.unreadable, [ID_A]);
  assert.equal(comparison.mismatched.length, 0);
  assert.equal(delegationSyncFindings(comparison), 0);
  assert.equal(delegationSyncUnmeasured(comparison), 1);
});

test("🔴 거둔 시각에 시간대가 없어도 못 읽은 것이다", () => {
  const comparison = compareDelegations({
    portal: [portalRow(ID_A)],
    house: [houseRow(ID_A, { revokedAt: "2026-11-15 03:04:05" })],
    truncated: false,
  });
  assert.deepEqual(comparison.unreadable, [ID_A]);
});

/* ------------------------------------------------------------------ */
/* 섞인 한 판 — 🔵 갈래가 서로를 먹지 않는지                             */
/* ------------------------------------------------------------------ */

test("한 판에 네 갈래가 섞여도 서로를 먹지 않는다", () => {
  const comparison = compareDelegations({
    portal: [
      portalRow(ID_A), // 같다
      portalRow(ID_B), // 기간이 다르다
      portalRow(ID_C, { bothHaveAccess: false }), // 포털에만 있다(설명됨)
    ],
    house: [
      houseRow(ID_A),
      houseRow(ID_B, { endsAt: "2026-12-01T00:00:00.000Z" }),
      houseRow("99999999-0000-4000-8000-000000000099"), // 집에만 있다
    ],
    truncated: false,
  });
  assertSampleSizes(comparison, { portal: 3, house: 3 });
  assert.deepEqual(comparison.matched, [ID_A]);
  assert.deepEqual(
    comparison.mismatched.map((row) => row.id),
    [ID_B]
  );
  assert.deepEqual(comparison.explainedPortalOnly, [ID_C]);
  assert.deepEqual(comparison.houseOnly, ["99999999-0000-4000-8000-000000000099"]);
  assert.equal(delegationSyncFindings(comparison), 2);
  assert.equal(delegationSyncUnmeasured(comparison), 0);
});

test("🔵 양쪽 다 비어 있으면 어긋남도 못 쟀다도 0 이다 — 빈 표본은 아무 말도 하지 않는다", () => {
  const comparison = compareDelegations({ portal: [], house: [], truncated: false });
  assertSampleSizes(comparison, { portal: 0, house: 0 });
  assert.equal(delegationSyncFindings(comparison), 0);
  assert.equal(delegationSyncUnmeasured(comparison), 0);
  // 🔴 그래서 **부르는 쪽**이 「포털에 줄이 한 줄이라도 있나」를 따로 세야 한다
  //    (scripts/check-delegation-sync.ts 의 그 자리). 여기서는 셀 수 없다.
});
