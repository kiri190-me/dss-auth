import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVAL_HISTORY_PERIOD_ERROR,
  approvalHistoryQuery,
  approvalHistoryUrl,
  readApprovalHistoryPeriod,
} from "./history-period";

/**
 * ============================================================================
 * 기간 — 🔴 **이 조각에서 가장 잘 깨지는 자리다**
 * ============================================================================
 * 이 파일이 지키는 것:
 *  · 세 집이 거절하는 꼴(날짜만 · 시간대 없는 T 꼴 · 공백이 된 `+09:00`)을
 *    **포털이 먼저** 거절한다. 세 집에 던져 놓고 셋이 400 을 내게 두면 승인함에
 *    뜨는 말이 「세 집을 다 못 물었다」가 되어 **제 실수를 안 가리킨다.**
 *  · 🔴 **굽는 자리가 언제나 `Z` 꼴을 낸다.** `+` 가 섞이면 쿼리에서 공백으로
 *    풀려 세 집이 한꺼번에 400 을 낸다.
 *  · 뒤집힌 기간은 **거절하지 않는다**(세 집이 그렇게 맞췄다).
 *
 * 🔴 **값은 전부 가짜다.** 실제 사람·고객사 이름은 한 글자도 들어가지 않는다.
 * ============================================================================
 */

/* ───────────────────────────────── 읽기 — 통과해야 하는 것 */

test("🔴 포털이 굽는 꼴(`toISOString()`)은 반드시 읽힌다 — 못 읽으면 제 답을 제가 거절한다", () => {
  const from = new Date("2026-11-01T00:00:00.000Z");
  const to = new Date("2026-12-01T00:00:00.000Z");
  const baked = new URLSearchParams(approvalHistoryQuery({ from, to }));

  const read = readApprovalHistoryPeriod({ from: baked.get("from"), to: baked.get("to") });
  assert.equal(read.ok, true);
  assert.ok(read.ok);
  assert.equal(read.period.from.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(read.period.to.toISOString(), "2026-12-01T00:00:00.000Z");
});

test("시간대가 붙어 있으면 초·밀리초가 없어도 읽는다 — 세 집의 정규식이 그렇다", () => {
  for (const text of [
    "2026-11-01T00:00Z",
    "2026-11-01T00:00:00Z",
    "2026-11-01T00:00:00.1Z",
    "2026-11-01T00:00:00.123456789Z",
    "2026-11-01t00:00:00z",
  ]) {
    const read = readApprovalHistoryPeriod({ from: text, to: "2026-12-01T00:00:00Z" });
    assert.equal(read.ok, true, `${text} 가 거절됐다`);
  }
});

test("🔴 `%2B` 로 제대로 인코딩해 보낸 `+09:00` 은 읽는다 — 거절하는 것은 **공백이 된** 쪽이다", () => {
  // 승인함이 form 본문에 `from=2026-11-01T00%3A00%3A00%2B09%3A00` 으로 적어 보낸 경우.
  const form = new URLSearchParams("from=2026-11-01T00%3A00%3A00%2B09%3A00&to=2026-12-01T00%3A00%3A00%2B09%3A00");
  const read = readApprovalHistoryPeriod({ from: form.get("from"), to: form.get("to") });
  assert.equal(read.ok, true);
  assert.ok(read.ok);
  // 🔴 KST 자정 = UTC 전날 15시. 값을 손보지 않았다는 증거다.
  assert.equal(read.period.from.toISOString(), "2026-10-31T15:00:00.000Z");
});

/* ───────────────────────────────── 읽기 — 거절해야 하는 것 */

test("🔴 날짜만 보내면 거절한다 — UTC 자정이라 한국 시간 첫날 아홉 시간이 조용히 빠진다", () => {
  const read = readApprovalHistoryPeriod({ from: "2026-11-01", to: "2026-12-01" });
  assert.equal(read.ok, false);
});

test("🔴 시간대 없는 T 꼴을 거절한다 — 개발 PC(KST)와 NAS(UTC)가 아홉 시간 어긋난다", () => {
  // 🔵 이것이 가장 그럴듯하게 틀리는 글자다. `Date` 는 오류를 내지 않는다.
  assert.equal(Number.isNaN(new Date("2026-11-01T00:00:00").getTime()), false);
  const read = readApprovalHistoryPeriod({ from: "2026-11-01T00:00:00", to: "2026-12-01T00:00:00" });
  assert.equal(read.ok, false);
});

test("🔴 `+` 가 공백으로 풀린 글자를 거절한다 — 인코딩 없이 실으면 이 꼴이 된다", () => {
  // form 본문에서도 쿼리에서도 `+` 는 공백이다. 보낸 쪽은 멀쩡히 보냈다고 믿는다.
  const form = new URLSearchParams("from=2026-11-01T00:00:00+09:00&to=2026-12-01T00:00:00+09:00");
  assert.equal(form.get("from"), "2026-11-01T00:00:00 09:00");
  const read = readApprovalHistoryPeriod({ from: form.get("from"), to: form.get("to") });
  assert.equal(read.ok, false);
});

test("🔴 숫자 한 글자를 거절한다 — `new Date()` 만 믿으면 26년치 기간이 조용히 열린다", () => {
  // 실측: `new Date("0")` 도 `new Date("2026")` 도 NaN 이 아니다.
  assert.equal(Number.isNaN(new Date("0").getTime()), false);
  assert.equal(Number.isNaN(new Date("2026").getTime()), false);
  assert.equal(readApprovalHistoryPeriod({ from: "0", to: "2026-12-01T00:00:00Z" }).ok, false);
  assert.equal(readApprovalHistoryPeriod({ from: "2026", to: "2026-12-01T00:00:00Z" }).ok, false);
});

test("🔴 둘 다 필수다 — 빠뜨린 요청이 조용히 전 기간을 열면 「줄이 좀 많네」로만 보인다", () => {
  assert.equal(readApprovalHistoryPeriod({ from: null, to: "2026-12-01T00:00:00Z" }).ok, false);
  assert.equal(readApprovalHistoryPeriod({ from: "2026-11-01T00:00:00Z", to: null }).ok, false);
  assert.equal(readApprovalHistoryPeriod({ from: null, to: null }).ok, false);
  assert.equal(readApprovalHistoryPeriod({ from: "", to: "" }).ok, false);
});

test("모양은 맞는데 없는 날이면 거절한다 — 정규식은 자릿수만 본다", () => {
  assert.equal(readApprovalHistoryPeriod({ from: "2026-13-45T00:00:00Z", to: "2026-12-01T00:00:00Z" }).ok, false);
});

test("🔵 뒤집힌 기간은 거절하지 않는다 — 세 집이 그렇게 맞췄다(빈 목록이 정직한 답)", () => {
  const read = readApprovalHistoryPeriod({
    from: "2026-12-01T00:00:00Z",
    to: "2026-11-01T00:00:00Z",
  });
  assert.equal(read.ok, true);
  assert.ok(read.ok);
  // 🔴 둘을 바꿔 끼우지도 않는다 — 부르는 쪽의 실수가 그럴듯한 답으로 덮이면 안 된다.
  assert.ok(read.period.from.getTime() > read.period.to.getTime());
});

/* ───────────────────────────────── 굽기 */

test("🔴 굽는 자리는 언제나 `Z` 꼴을 낸다 — `+` 가 섞이면 세 집이 한꺼번에 400 이다", () => {
  // 들어온 값이 `+09:00` 이어도 나가는 글자에는 `+` 가 없어야 한다.
  const read = readApprovalHistoryPeriod({
    from: "2026-11-01T00:00:00+09:00",
    to: "2026-12-01T00:00:00+09:00",
  });
  assert.ok(read.ok);

  const query = approvalHistoryQuery(read.period);
  assert.equal(query.includes("+"), false, "굽힌 글자에 + 가 섞였다");
  assert.equal(query.includes("%2B"), false);
  assert.equal(query.includes(" "), false);

  const parsed = new URLSearchParams(query);
  assert.equal(parsed.get("from"), "2026-10-31T15:00:00.000Z");
  assert.equal(parsed.get("to"), "2026-11-30T15:00:00.000Z");
});

test("🔴 구운 글자를 **세 집의 정규식 그대로** 다시 재 본다 — 통과 못 하면 셋이 다 400 이다", () => {
  // 🔴 세 집(A/S · 재고관리 · 휴가)이 쓰는 글자 그대로 베낀 정규식이다.
  //    포털이 굽는 값은 **반드시** 이것을 통과해야 한다.
  const theirs =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

  for (const pair of [
    { from: "2026-11-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" },
    { from: "2026-11-01T00:00+09:00", to: "2026-11-02T00:00-05:00" },
    { from: "2026-02-29T23:59:59.999Z", to: "2026-03-01T00:00:00Z" },
  ]) {
    const read = readApprovalHistoryPeriod(pair);
    assert.ok(read.ok, `${pair.from} 를 못 읽었다`);
    const baked = new URLSearchParams(approvalHistoryQuery(read.period));
    assert.match(baked.get("from") ?? "", theirs);
    assert.match(baked.get("to") ?? "", theirs);
  }
});

test("🔴 주소에 싣는 것은 기간 둘뿐이다 — 사람 번호는 주소에 안 실린다", () => {
  const read = readApprovalHistoryPeriod({
    from: "2026-11-01T00:00:00Z",
    to: "2026-12-01T00:00:00Z",
  });
  assert.ok(read.ok);

  const url = approvalHistoryUrl(
    "http://as.test:3000/api/integration/approval-history",
    read.period
  );
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/api/integration/approval-history");
  assert.deepEqual([...parsed.searchParams.keys()].sort(), ["from", "to"]);
  // 🔴 「사람이 안 실린다」를 글자로도 한 번 더 못 박는다.
  assert.equal(url.includes("sub"), false);
});

test("거절의 글자는 세 집과 같은 `invalid_period` 다 — 포털이 제 말을 지어 쓰면 못 가른다", () => {
  assert.equal(APPROVAL_HISTORY_PERIOD_ERROR, "invalid_period");
});
