import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_ITEMS_PER_SOURCE,
  mergeSourceOutcomes,
  parseSourceFeed,
  type SourceOutcome,
} from "./merge";
import type { NotificationSource } from "./sources";

const AS: NotificationSource = {
  clientId: "rf-service-system",
  name: "DSS A/S 관리 시스템",
  notificationsUrl: "http://192.168.0.12:3000/api/integration/notifications",
  settingsUrl: "http://192.168.0.12:3000/api/integration/notification-settings",
};

const METERS: NotificationSource = {
  clientId: "dss-meters",
  name: "계측기 관리",
  notificationsUrl: "http://192.168.0.12:3200/api/integration/notifications",
  settingsUrl: "http://192.168.0.12:3200/api/integration/notification-settings",
};

/** A/S 가 실제로 내주는 한 줄(그쪽 ExternalNotificationItem). */
function item(over: Record<string, unknown> = {}) {
  return {
    id: "REPAIR_CASE_APPROVAL:RC-2026-0001",
    kind: "REPAIR_CASE_APPROVAL",
    kindLabel: "접수건 결재 대기",
    targetKey: "REPAIR_CASE:RC-2026-0001",
    subject: "RC-2026-0001 결재 대기",
    detail: "삼성전자 · 신호발생기",
    href: "http://192.168.0.12:3000/repair-cases/RC-2026-0001",
    ...over,
  };
}

test("받은 줄을 그대로 옮기고 출처만 더한다", () => {
  const feed = parseSourceFeed({ items: [item()], count: 1 }, AS);
  assert.equal(feed.count, 1);
  assert.deepEqual(feed.items[0], {
    key: "rf-service-system:REPAIR_CASE_APPROVAL:RC-2026-0001",
    sourceId: "rf-service-system",
    sourceName: "DSS A/S 관리 시스템",
    id: "REPAIR_CASE_APPROVAL:RC-2026-0001",
    kind: "REPAIR_CASE_APPROVAL",
    kindLabel: "접수건 결재 대기",
    subject: "RC-2026-0001 결재 대기",
    detail: "삼성전자 · 신호발생기",
    href: "http://192.168.0.12:3000/repair-cases/RC-2026-0001",
  });
});

test("🔴 링크를 다시 가공하지 않는다 — 앞에 무엇도 붙이지 않는다", () => {
  // A/S 가 이미 자기 주소를 붙여 보낸다. 여기서 또 붙이면 두 번 붙어 어디로도
  // 가지 못한다.
  const href = "http://192.168.0.12:3000/inventory?low=1";
  const feed = parseSourceFeed({ items: [item({ href })], count: 1 }, AS);
  assert.equal(feed.items[0].href, href);
});

test("🔴 다른 시스템의 같은 id 가 섞여도 열쇠가 겹치지 않는다", () => {
  const fromAs = parseSourceFeed({ items: [item({ id: "X" })], count: 1 }, AS);
  const fromMeters = parseSourceFeed({ items: [item({ id: "X" })], count: 1 }, METERS);
  assert.notEqual(fromAs.items[0].key, fromMeters.items[0].key);
});

test("🔴 눌러서 갈 수 없는 링크는 버린다 — javascript: 는 종에서 코드가 된다", () => {
  const feed = parseSourceFeed(
    {
      items: [
        item({ id: "a", href: "javascript:alert(1)" }),
        item({ id: "b", href: "/repair-cases/RC-1" }),
        item({ id: "c" }),
      ],
      count: 3,
    },
    AS
  );
  assert.deepEqual(
    feed.items.map((row) => row.id),
    ["c"]
  );
});

test("개수는 저쪽이 센 값을 쓴다 — 목록 길이를 다시 세지 않는다", () => {
  // 같은 대상에 결재가 둘 걸린 사람은 줄이 둘이어도 배지는 1이다(A/S 의 규칙).
  // 여기서 길이를 세면 A/S 의 종과 포털의 종이 다른 숫자를 보여 준다.
  const feed = parseSourceFeed(
    { items: [item({ id: "a" }), item({ id: "b" })], count: 1 },
    AS
  );
  assert.equal(feed.items.length, 2);
  assert.equal(feed.count, 1);
});

test("보이는 줄보다 큰 숫자는 깎는다", () => {
  const feed = parseSourceFeed({ items: [item()], count: 99 }, AS);
  assert.equal(feed.count, 1);
});

test("모양이 깨진 답에도 던지지 않는다", () => {
  for (const raw of [null, undefined, 0, "", "그냥 글자", [], {}, { items: null }]) {
    assert.deepEqual(parseSourceFeed(raw, AS), { items: [], count: 0 });
  }
});

test("줄 하나가 이상해도 나머지는 살린다", () => {
  const feed = parseSourceFeed(
    { items: [null, 7, { id: "" }, item({ id: "ok" }), { href: "http://x/y" }], count: 1 },
    AS
  );
  assert.deepEqual(
    feed.items.map((row) => row.id),
    ["ok"]
  );
});

test("종류 이름이 없어도 알림 자체는 살린다", () => {
  const feed = parseSourceFeed(
    { items: [item({ kind: undefined, kindLabel: undefined, detail: undefined })], count: 1 },
    AS
  );
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].kindLabel, "");
});

test("🔴 targetKey 는 옮기지 않는다 — 받는 쪽이 개수를 다시 세면 안 된다", () => {
  const feed = parseSourceFeed({ items: [item()], count: 1 }, AS);
  assert.ok(!("targetKey" in feed.items[0]), JSON.stringify(feed.items[0]));
});

test("한 시스템이 수만 줄을 보내도 상한에서 끊는다", () => {
  const many = Array.from({ length: MAX_ITEMS_PER_SOURCE + 500 }, (_, i) =>
    item({ id: `RC-${i}` })
  );
  const feed = parseSourceFeed({ items: many, count: many.length }, AS);
  assert.equal(feed.items.length, MAX_ITEMS_PER_SOURCE);
  assert.equal(feed.count, MAX_ITEMS_PER_SOURCE);
});

// ─────────────────────────────────────────────────────────────── 합치기

test("여러 시스템의 줄을 시스템 차례대로 이어 붙인다", () => {
  const merged = mergeSourceOutcomes([
    { source: AS, ok: true, feed: parseSourceFeed({ items: [item({ id: "a" })], count: 1 }, AS) },
    {
      source: METERS,
      ok: true,
      feed: parseSourceFeed({ items: [item({ id: "b" })], count: 1 }, METERS),
    },
  ]);
  assert.deepEqual(
    merged.items.map((row) => row.sourceId),
    ["rf-service-system", "dss-meters"]
  );
  assert.equal(merged.count, 2);
  assert.equal(merged.degraded, false);
});

test("🔴 한 시스템이 죽어도 나머지 결과가 나온다", () => {
  const merged = mergeSourceOutcomes([
    { source: AS, ok: false },
    {
      source: METERS,
      ok: true,
      feed: parseSourceFeed({ items: [item({ id: "b" })], count: 1 }, METERS),
    },
  ]);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.count, 1);
  assert.equal(merged.degraded, true);
  assert.deepEqual(merged.sources, [
    { clientId: "rf-service-system", name: "DSS A/S 관리 시스템", ok: false, count: 0 },
    { clientId: "dss-meters", name: "계측기 관리", ok: true, count: 1 },
  ]);
});

test("🔴 빈 목록과 못 물어본 것은 다른 얼굴이다", () => {
  const empty = mergeSourceOutcomes([
    { source: AS, ok: true, feed: { items: [], count: 0 } },
  ]);
  const broken = mergeSourceOutcomes([{ source: AS, ok: false }]);

  // 둘 다 줄이 없지만, 하나는 정상이고 하나는 사고다. 종이 같은 얼굴로
  // 그리면 안 된다 — A/S 실측에서 활성 사용자 12명 중 4명만 포털 계정과
  // 이어져 있었다. 나머지에게 빈 목록은 정상이다.
  assert.equal(empty.items.length, 0);
  assert.equal(empty.degraded, false);
  assert.equal(broken.items.length, 0);
  assert.equal(broken.degraded, true);
});

test("물어본 곳이 모두 죽어도 터지지 않는다", () => {
  const merged = mergeSourceOutcomes([
    { source: AS, ok: false },
    { source: METERS, ok: false },
  ] satisfies SourceOutcome[]);
  assert.deepEqual(merged.items, []);
  assert.equal(merged.count, 0);
  assert.equal(merged.degraded, true);
});

test("물어볼 곳이 없으면 degraded 가 아니다", () => {
  const merged = mergeSourceOutcomes([]);
  assert.deepEqual(merged, { items: [], count: 0, sources: [], degraded: false });
});
