import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_DISMISSAL_KEYS_PER_REQUEST,
  applyDismissals,
  applySiteDismissals,
  parseDismissalKey,
  readDismissalKeys,
} from "./dismissals";
import type { PortalNotificationFeed, PortalNotificationItem } from "./merge";

/** 종에 그려지는 한 줄. 열쇠는 merge.ts 가 만드는 모양 그대로다. */
function item(over: Partial<PortalNotificationItem> = {}): PortalNotificationItem {
  const base: PortalNotificationItem = {
    key: "rf-service-system:REPAIR_CASE_APPROVAL:RC-2026-0001",
    sourceId: "rf-service-system",
    sourceName: "DSS A/S 관리 시스템",
    id: "REPAIR_CASE_APPROVAL:RC-2026-0001",
    kind: "REPAIR_CASE_APPROVAL",
    kindLabel: "접수건 결재 대기",
    subject: "RC-2026-0001 결재 대기",
    detail: "가나상사 · 신호발생기",
    href: "http://192.168.0.12:3000/repair-cases/RC-2026-0001",
  };
  return { ...base, ...over };
}

/** 어느 시스템의 줄 하나. 열쇠를 `{clientId}:{id}` 로 맞춰 준다. */
function row(clientId: string, id: string): PortalNotificationItem {
  return item({ key: `${clientId}:${id}`, sourceId: clientId, id });
}

function feed(over: Partial<PortalNotificationFeed> = {}): PortalNotificationFeed {
  const base: PortalNotificationFeed = {
    items: [row("rf-service-system", "a"), row("dss-leave", "b")],
    count: 2,
    sources: [
      { clientId: "rf-service-system", name: "DSS A/S 관리 시스템", ok: true, count: 1 },
      { clientId: "dss-leave", name: "DSS 휴가 관리", ok: true, count: 1 },
    ],
    degraded: false,
  };
  return { ...base, ...over };
}

/* ── 열쇠 가르기 ──────────────────────────────────────────────────────────── */

test("🔴 ① 첫 `:` 에서만 가른다 — id 안의 `:` 가 살아남는다", () => {
  // A/S 의 id 는 「종류:대상」 모양이라 `:` 를 품고 있다. 마지막 `:` 에서 가르면
  // 그 열쇠들이 전부 어긋나고, 증상은 「지웠는데 그대로 뜬다」 하나뿐이다.
  assert.deepEqual(parseDismissalKey("rf-service-system:REPAIR_CASE_APPROVAL:RC-2026-0001"), {
    clientId: "rf-service-system",
    id: "REPAIR_CASE_APPROVAL:RC-2026-0001",
  });
});

test("merge 가 만든 열쇠를 그대로 되돌려 읽는다", () => {
  const made = row("dss-inventory", "OUTBOUND_CONFIRM:REQ-77").key;
  assert.deepEqual(parseDismissalKey(made), {
    clientId: "dss-inventory",
    id: "OUTBOUND_CONFIRM:REQ-77",
  });
});

test("앞뒤 어느 쪽이든 비면 열쇠가 아니다", () => {
  for (const bad of ["", ":", ":abc", "abc:", "콜론없음", "   "]) {
    assert.equal(parseDismissalKey(bad), null, bad);
  }
});

/* ── 본문 읽기 ────────────────────────────────────────────────────────────── */

test("쉼표로 나뉜 목록을 읽고 공백을 턴다", () => {
  const result = readDismissalKeys("sub=u1&keys=rf-service-system:a, dss-leave:b ,");
  assert.deepEqual(result, {
    ok: true,
    keys: ["rf-service-system:a", "dss-leave:b"],
    dropped: 0,
  });
});

test("같은 열쇠를 두 번 보내도 한 번이다 — 중복은 dropped 가 아니다", () => {
  const result = readDismissalKeys("keys=dss-board:x,dss-board:x,dss-board:x");
  assert.deepEqual(result, { ok: true, keys: ["dss-board:x"], dropped: 0 });
});

test("🔴 ② 모양이 틀린 열쇠 하나가 일괄 전체를 거절시키지 않는다", () => {
  // 일괄 지우기가 통째로 실패하면 사람이 할 수 있는 일이 없다 — 어느 줄이
  // 문제인지 화면에 나오지도 않고, 하나씩 지워 볼 수도 없다.
  const result = readDismissalKeys("keys=rf-service-system:a,콜론없음,dss-leave:b");
  assert.deepEqual(result, {
    ok: true,
    keys: ["rf-service-system:a", "dss-leave:b"],
    dropped: 1,
  });
});

test("🔴 ③ 모르는 clientId 는 버리고 dropped 에 센다", () => {
  // 계측기·PO 는 등록된 시스템이지만 **제 알림이 없다.** 그런 열쇠는 어디서도
  // 만들어지지 않으므로 판정의 기준은 clients 표가 아니라 알림을 내는 다섯이다.
  const result = readDismissalKeys("keys=dss-meters:a,없는시스템:b,rf-service-system:c");
  assert.deepEqual(result, { ok: true, keys: ["rf-service-system:c"], dropped: 2 });
});

test("🔴 프로토타입의 이름이 등록된 시스템인 척 통과하지 못한다", () => {
  // `in` 으로 판정하면 `constructor` · `toString` 이 전부 true 가 된다.
  const result = readDismissalKeys("keys=constructor:a,toString:b,__proto__:c");
  assert.deepEqual(result, { ok: false, reason: "no_keys" });
});

test("쓸 열쇠가 하나도 없으면 no_keys", () => {
  for (const body of ["", "sub=u1", "keys=", "keys=,,,", "keys=쓰레기,:,x:"]) {
    assert.deepEqual(readDismissalKeys(body), { ok: false, reason: "no_keys" }, body);
  }
});

test("🔴 keys 가 여러 번 실려 와도 전부 읽는다 — get 은 첫 값만 읽는다", () => {
  // 보내는 쪽이 URLSearchParams.append 를 줄마다 부르면 이 모양이 된다.
  // 첫 값만 읽으면 지운 줄의 절반이 조용히 안 지워진다.
  const result = readDismissalKeys("keys=rf-service-system:a&keys=dss-leave:b");
  assert.deepEqual(result, {
    ok: true,
    keys: ["rf-service-system:a", "dss-leave:b"],
    dropped: 0,
  });
});

/* ── 개수 상한 ────────────────────────────────────────────────────────────── */

test("🔴 상한은 200이다 — 2026-10-20 사용자 결정, 말없이 움직이면 안 된다", () => {
  // 「상한이 몇인가」를 못 박아 두는 한 줄이다. 이 값은 사람이 치르는 값까지
  // 듣고 고른 것이라(상수 주석의 「치르는 값」·「다시 꺼낼 조건」) 코드만 보고
  // 올리거나 내릴 값이 아니다.
  assert.equal(MAX_DISMISSAL_KEYS_PER_REQUEST, 200);
});

test("🔴 상한 정확히까지는 받는다 — 경계에서 한 끗 차이로 거절하지 않는다", () => {
  // 실제 알림은 두 자릿수다(merge.ts 의 MAX_ITEMS_PER_SOURCE 주석). 200이면
  // 그 몇 배라 평범한 일괄 지우기는 전부 이 안에 들어온다.
  const keys = Array.from(
    { length: MAX_DISMISSAL_KEYS_PER_REQUEST },
    (_, i) => `rf-service-system:RC-${i}`
  );
  const result = readDismissalKeys(`keys=${keys.join(",")}`);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.keys.length, MAX_DISMISSAL_KEYS_PER_REQUEST);
});

test("🔴 ④ 상한을 넘으면 too_many — 자르지 않는다", () => {
  // 조용히 앞의 200개만 받으면 사람은 전부 지웠다고 믿는데 나머지는 남는다.
  // 그 어긋남은 「지웠는데 다시 뜬다」로만 보여 원인을 가리키지 않는다.
  // 🔵 종에 보일 수 있는 줄은 이론상 1000까지 가므로 이 거절은 실제로 일어날
  // 수 있다 — 알고 받아들인 값이고, 까닭은 상수 주석에 적혀 있다.
  const keys = Array.from(
    { length: MAX_DISMISSAL_KEYS_PER_REQUEST + 1 },
    (_, i) => `rf-service-system:RC-${i}`
  );
  const result = readDismissalKeys(`keys=${keys.join(",")}`);
  assert.deepEqual(result, { ok: false, reason: "too_many" });
  // 🔴 거절일 때는 열쇠가 아예 돌아오지 않는다 — 부르는 쪽이 「받은 것만이라도
  // 쓰자」로 흘러가면 자른 것과 똑같아진다.
  assert.ok(!("keys" in result));
});

test("🔴 상한은 버린 뒤 남은 수로 센다 — 쓰레기 때문에 멀쩡한 일괄이 거절되지 않는다", () => {
  const good = Array.from(
    { length: MAX_DISMISSAL_KEYS_PER_REQUEST },
    (_, i) => `rf-service-system:RC-${i}`
  );
  const junk = Array.from({ length: 50 }, (_, i) => `없는시스템:RC-${i}`);
  const result = readDismissalKeys(`keys=${[...good, ...junk].join(",")}`);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.dropped, 50);
});

/* ── 거르기 ───────────────────────────────────────────────────────────────── */

test("🔴 ⑤ count 와 sources[].count 가 items 와 함께 줄어든다", () => {
  const applied = applyDismissals(feed(), new Set(["rf-service-system:a"]));
  assert.deepEqual(
    applied.items.map((entry) => entry.key),
    ["dss-leave:b"]
  );
  assert.equal(applied.count, 1);
  assert.deepEqual(
    applied.sources.map((source) => source.count),
    [0, 1]
  );
});

test("지운 줄이 없으면 숫자가 그대로다", () => {
  const applied = applyDismissals(feed(), new Set(["dss-board:모르는줄"]));
  assert.equal(applied.items.length, 2);
  assert.equal(applied.count, 2);
});

test("🔴 ⑥ 숫자가 0 아래로 내려가지 않는다", () => {
  // 실제로 일어나는 모양이다: 저쪽은 「같은 대상은 한 번만」 세므로 줄 둘에
  // 개수 1을 보낼 수 있고(merge.ts 의 targetKey 주석), 포털은 그 규칙을 모른다.
  const twoRowsOneCount = feed({
    items: [row("rf-service-system", "a"), row("rf-service-system", "b")],
    count: 1,
    sources: [{ clientId: "rf-service-system", name: "DSS A/S 관리 시스템", ok: true, count: 1 }],
  });
  const applied = applyDismissals(
    twoRowsOneCount,
    new Set(["rf-service-system:a", "rf-service-system:b"])
  );
  assert.deepEqual(applied.items, []);
  assert.equal(applied.count, 0);
  assert.equal(applied.sources[0].count, 0);
});

test("🔴 degraded 와 sources 의 차례·ok 는 그대로다", () => {
  // 「못 물어봤다」는 지움과 아무 상관이 없는 사실이다. 흐려지면 빈 목록과
  // 사고를 나눠 그릴 수 없게 된다.
  const broken = feed({
    items: [row("dss-leave", "b")],
    count: 1,
    sources: [
      { clientId: "rf-service-system", name: "DSS A/S 관리 시스템", ok: false, count: 0 },
      { clientId: "dss-leave", name: "DSS 휴가 관리", ok: true, count: 1 },
    ],
    degraded: true,
  });
  const applied = applyDismissals(broken, new Set(["dss-leave:b"]));
  assert.equal(applied.degraded, true);
  assert.deepEqual(applied.sources, [
    { clientId: "rf-service-system", name: "DSS A/S 관리 시스템", ok: false, count: 0 },
    { clientId: "dss-leave", name: "DSS 휴가 관리", ok: true, count: 0 },
  ]);
});

test("🔴 ⑦ 원본 feed 가 바뀌지 않는다 — 들어오는 것은 캐시에 든 바로 그 객체다", () => {
  // 제자리에서 고치면 거른 결과가 30초 캐시에 남아 **다음 사람의 종에서**
  // 멀쩡한 알림이 사라진다.
  const original = feed();
  const beforeItems = original.items.length;
  const beforeCount = original.count;
  const beforeSourceCounts = original.sources.map((source) => source.count);

  const applied = applyDismissals(original, new Set(["rf-service-system:a", "dss-leave:b"]));

  assert.equal(applied.items.length, 0);
  assert.equal(applied.count, 0);
  assert.equal(original.items.length, beforeItems);
  assert.equal(original.count, beforeCount);
  assert.deepEqual(
    original.sources.map((source) => source.count),
    beforeSourceCounts
  );
});

test("🔴 지울 것이 없어도 새 객체를 돌려준다 — 원본을 그대로 돌려주는 갈래가 없다", () => {
  // 「어떨 때는 원본」이라는 성질이 있으면 부르는 쪽이 무엇을 받았는지 알 수
  // 없고, 그 경우에만 캐시가 오염된다.
  const original = feed();
  const applied = applyDismissals(original, new Set<string>());
  assert.notEqual(applied, original);
  assert.notEqual(applied.items, original.items);
  assert.notEqual(applied.sources, original.sources);
  assert.notEqual(applied.sources[0], original.sources[0]);
  assert.deepEqual(applied, original);
});

/* ── 사이트에 내줄 때 ─────────────────────────────────────────────────────── */

test("🔴 ⑧ dismissed 에는 부른 사이트의 열쇠만 담긴다 — 남의 시스템 것은 안 간다", () => {
  // 열쇠의 id 에는 수리 건 번호 같은 업무 식별자가 들어 있다. 전부 보내면
  // 「그 사람이 다른 시스템에서 무엇을 지웠는지」가 그대로 넘어간다.
  const applied = applySiteDismissals(
    feed(),
    new Set([
      "rf-service-system:REPAIR_CASE_APPROVAL:RC-2026-0001",
      "dss-leave:b",
      "dss-inventory:OUTBOUND_CONFIRM:REQ-77",
    ]),
    "rf-service-system"
  );
  assert.deepEqual(applied.dismissed, ["rf-service-system:REPAIR_CASE_APPROVAL:RC-2026-0001"]);
});

test("🔴 접두사가 비슷한 시스템이 섞여 들어가지 않는다 — 첫 `:` 까지가 전부 같아야 한다", () => {
  // `startsWith(clientId)` 로 골랐다면 `dss-leave-admin:…` 이 `dss-leave` 의
  // 몫으로 딸려 간다. 판정이 parseDismissalKey 하나라야 그 길이 없다.
  const applied = applySiteDismissals(
    feed(),
    new Set(["dss-leave-admin:x", "dss-leave:b"]),
    "dss-leave"
  );
  assert.deepEqual(applied.dismissed, ["dss-leave:b"]);
});

test("🔴 items·count·sources[].count 가 applyDismissals 와 똑같이 줄어든다", () => {
  // 거르는 규칙이 두 벌이 되면 포털의 종과 사이트의 종이 다른 숫자를 보여 준다.
  const dismissed = new Set(["rf-service-system:a"]);
  const site = applySiteDismissals(feed(), dismissed, "rf-service-system");
  const plain = applyDismissals(feed(), dismissed);

  assert.deepEqual(site.items, plain.items);
  assert.equal(site.count, plain.count);
  assert.deepEqual(site.sources, plain.sources);
  assert.equal(site.degraded, plain.degraded);
});

test("지운 것이 없으면 dismissed 는 빈 배열이다 — 칸 자체는 언제나 있다", () => {
  // 없을 때 칸을 빼면 사이트가 `?? []` 를 들어야 하고, 안 들면 그날 터진다.
  const applied = applySiteDismissals(feed(), new Set<string>(), "rf-service-system");
  assert.deepEqual(applied.dismissed, []);
  assert.equal(applied.items.length, 2);
  assert.equal(applied.count, 2);
});

test("🔴 ⑨ 원본 feed 가 바뀌지 않는다 — 들어오는 것은 캐시에 든 바로 그 객체다", () => {
  const original = feed();
  const beforeItems = original.items.length;
  const beforeCount = original.count;
  const beforeSourceCounts = original.sources.map((source) => source.count);

  const applied = applySiteDismissals(
    original,
    new Set(["rf-service-system:a", "dss-leave:b"]),
    "dss-leave"
  );

  assert.equal(applied.items.length, 0);
  assert.equal(original.items.length, beforeItems);
  assert.equal(original.count, beforeCount);
  assert.deepEqual(
    original.sources.map((source) => source.count),
    beforeSourceCounts
  );
  assert.equal("dismissed" in original, false);
});

test("🔴 모양이 깨진 열쇠가 섞여 있어도 터지지 않고 그냥 안 담긴다", () => {
  // 표에 쌓인 열쇠도 결국 **바깥에서 지어 보낸 문자열**이다. 쓰기 통로가 걸러
  // 주지만, 그 통로가 느슨해지는 날 여기서 터지면 사이트의 화면이 통째로 안 뜬다.
  const applied = applySiteDismissals(
    feed(),
    new Set(["", ":", ":abc", "abc:", "콜론없음", "rf-service-system:a"]),
    "rf-service-system"
  );
  assert.deepEqual(applied.dismissed, ["rf-service-system:a"]);
});

test("읽기와 거르기가 이어 붙는다 — 본문에서 읽은 열쇠로 바로 거른다", () => {
  const result = readDismissalKeys("sub=u1&keys=rf-service-system:a,없는시스템:z");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const applied = applyDismissals(feed(), new Set(result.keys));
  assert.deepEqual(
    applied.items.map((entry) => entry.key),
    ["dss-leave:b"]
  );
  assert.equal(result.dropped, 1);
});
