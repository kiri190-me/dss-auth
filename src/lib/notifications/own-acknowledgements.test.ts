import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contentDigest, type AcknowledgementState } from "./acknowledgements";
import type { SiteDismissalFeed } from "./dismissals";
import type { PortalNotificationItem } from "./merge";
import type { NotificationPurpose } from "./purposes";
import { ownAcknowledgedKeys, withOwnAcknowledgements } from "./own-acknowledgements";

/**
 * ============================================================================
 * 사이트가 **제 알림**도 확인(✓)으로 거를 수 있게 — 내려보낼 열쇠
 * ============================================================================
 * 메우려는 구멍: [재고부족] 을 A/S 종에서 ✓ 하면 A/S·PO·게시판에서는 사라지는데
 * **재고관리 제 종에서는 그대로 남았다.** 제 알림은 제 DB 에서 그리는데 포털이
 * 「이건 확인됐다」를 안 알려 줬기 때문이다.
 *
 * 이 파일이 못 박는 것 다섯:
 *
 *  1. 🔴 **내용이 바뀌면 안 내려간다.** 「3종 더」를 확인한 뒤 「10종 더」가 오면
 *     그 열쇠는 빠진다 — 안 그러면 쓰는 분이 든 바로 그 알림이 영영 안 보인다.
 *  2. 🔴 **승인용은 안 내려간다.** 기록이 있어도, 저장된 분류가 없어도(기본값이
 *     승인용이다) 마찬가지다.
 *  3. 🔴 **남의 시스템 몫은 안 내려간다.** 열쇠의 id 에는 업무 식별자가 들어 있다.
 *  4. 🔴 **`dismissed` 와 섞이지 않는다.** 수명이 정반대라 섞이면 로그아웃이
 *     이상해지거나(확인→지움) 영구히 사라진다(지움→확인).
 *  5. 🔴 **모를 때는 안 뺀다.** 못 물어봤으면 빈 배열이다 — 「한 번 더 보인다」와
 *     「아직 안 한 일이 안 보인다」 가운데 앞쪽을 고른다.
 * ============================================================================
 */

const INVENTORY = "dss-inventory";

/** 재고관리의 「N종 더」 — id 가 고정이라 지문이 없으면 영영 숨는 바로 그 줄. */
function ownItem(over: Partial<PortalNotificationItem> = {}): PortalNotificationItem {
  return {
    key: `${INVENTORY}:PARTS_LOW_STOCK_MORE`,
    sourceId: INVENTORY,
    sourceName: "재고관리",
    id: "PARTS_LOW_STOCK_MORE",
    kind: "LOW_STOCK",
    kindLabel: "한계수량",
    subject: "한계수량 이하인 부품이 3종 더 있습니다",
    detail: "재고 현황 목록에서 봅니다",
    href: "http://example.invalid/parts",
    ...over,
  };
}

function purposesOf(
  rows: [client: string, kind: string, purpose: NotificationPurpose][]
): ReadonlyMap<string, ReadonlyMap<string, NotificationPurpose>> {
  const byClient = new Map<string, Map<string, NotificationPurpose>>();
  for (const [client, kind, purpose] of rows) {
    const kinds = byClient.get(client) ?? new Map<string, NotificationPurpose>();
    kinds.set(kind, purpose);
    byClient.set(client, kinds);
  }
  return byClient;
}

/** 그 줄들을 **지금 내용 그대로** 확인해 둔 상태. 분류는 따로 받는다. */
function stateFor(
  items: readonly PortalNotificationItem[],
  purposes: ReadonlyMap<string, ReadonlyMap<string, NotificationPurpose>>
): AcknowledgementState {
  return {
    digests: new Map(items.map((row) => [row.key, contentDigest(row.subject, row.detail)])),
    purposes,
  };
}

function siteFeed(over: Partial<SiteDismissalFeed> = {}): SiteDismissalFeed {
  return {
    items: [],
    count: 0,
    sources: [],
    degraded: false,
    dismissed: [],
    ...over,
  };
}

test("🔴 확인해 둔 제 줄의 열쇠가 그 사이트 몫으로 내려간다", () => {
  const items = [ownItem()];
  const keys = ownAcknowledgedKeys({
    ownItems: items,
    state: stateFor(items, purposesOf([[INVENTORY, "LOW_STOCK", "INFO"]])),
    clientId: INVENTORY,
  });

  // 이 한 줄이 없으면 「A/S 에서 ✓ 했는데 재고관리 종에만 그대로 뜬다」가 된다.
  assert.deepEqual(keys, [`${INVENTORY}:PARTS_LOW_STOCK_MORE`]);
});

test("🔴 지문이 다르면 안 내려간다 — 「3종 더」를 확인했는데 「10종 더」가 왔다", () => {
  const confirmed = [ownItem({ subject: "한계수량 이하인 부품이 3종 더 있습니다" })];
  const nowShowing = [ownItem({ subject: "한계수량 이하인 부품이 10종 더 있습니다" })];

  const keys = ownAcknowledgedKeys({
    ownItems: nowShowing,
    // 🔴 확인해 둔 것은 **3종일 때의 내용**이다. 열쇠는 둘이 같다(id 가 고정).
    state: stateFor(confirmed, purposesOf([[INVENTORY, "LOW_STOCK", "INFO"]])),
    clientId: INVENTORY,
  });

  assert.deepEqual(
    keys,
    [],
    "내용이 바뀌었는데 열쇠가 내려간다 — 10종이 되어도 영영 안 보이게 된다"
  );
});

test("🔴 분류가 승인용이면 안 내려간다 — 기록이 있어도 거르지 않는다", () => {
  const items = [ownItem()];
  const keys = ownAcknowledgedKeys({
    ownItems: items,
    state: stateFor(items, purposesOf([[INVENTORY, "LOW_STOCK", "ACTION"]])),
    clientId: INVENTORY,
  });

  // 기록은 남아 있다. 관리자가 분류를 `INFO` 로 바꾸는 날부터 먹는다.
  assert.deepEqual(keys, []);
});

test("🔴 분류가 저장돼 있지 않으면 안 내려간다 — 모르면 승인용이다", () => {
  const items = [ownItem()];
  const keys = ownAcknowledgedKeys({
    ownItems: items,
    state: stateFor(items, purposesOf([])),
    clientId: INVENTORY,
  });

  assert.deepEqual(keys, [], "저장된 행이 없는 종류가 내려갔다 — 기본값은 승인용이다");
});

test("🔴 확인 기록이 없는 줄은 안 내려간다", () => {
  const keys = ownAcknowledgedKeys({
    ownItems: [ownItem()],
    state: { digests: new Map(), purposes: purposesOf([[INVENTORY, "LOW_STOCK", "INFO"]]) },
    clientId: INVENTORY,
  });

  assert.deepEqual(keys, []);
});

test("🔴 남의 시스템 줄의 열쇠는 내려가지 않는다 — 무엇을 확인했는지가 새면 안 된다", () => {
  // 열쇠의 id 에는 `REPAIR_CASE_APPROVAL:RC-2026-0001` 처럼 업무 식별자가 들어
  // 있다. 알림 본문은 걸러 보내면서 그 알림의 열쇠를 보내는 것은 앞뒤가 안 맞는다.
  const theirs = ownItem({
    key: "rf-service-system:REPAIR_CASE_APPROVAL:RC-2026-0001",
    sourceId: "rf-service-system",
    sourceName: "DSS A/S 관리 시스템",
    id: "REPAIR_CASE_APPROVAL:RC-2026-0001",
    kind: "REPAIR_CASE_APPROVAL",
  });
  const mine = ownItem();
  const items = [theirs, mine];

  const keys = ownAcknowledgedKeys({
    ownItems: items,
    state: stateFor(
      items,
      purposesOf([
        [INVENTORY, "LOW_STOCK", "INFO"],
        ["rf-service-system", "REPAIR_CASE_APPROVAL", "INFO"],
      ])
    ),
    clientId: INVENTORY,
  });

  assert.deepEqual(keys, [mine.key], "부른 사이트 몫이 아닌 열쇠가 내려갔다");
});

test("🔴 모양이 깨진 열쇠는 조용히 빠진다 — 첫 `:` 하나로 가른다", () => {
  const broken = ownItem({ key: `${INVENTORY}:`, id: "" });
  const items = [broken];

  const keys = ownAcknowledgedKeys({
    ownItems: items,
    state: stateFor(items, purposesOf([[INVENTORY, "LOW_STOCK", "INFO"]])),
    clientId: INVENTORY,
  });

  assert.deepEqual(keys, []);
});

test("🔴 `dismissed` 와 `acknowledged` 는 섞이지 않는다 — 수명이 정반대다", () => {
  const dismissed = [`${INVENTORY}:SHIPMENT_WAIT:7`];
  const acknowledged = [`${INVENTORY}:PARTS_LOW_STOCK_MORE`];

  const feed = withOwnAcknowledgements(siteFeed({ dismissed }), acknowledged);

  // 지움은 로그아웃하면 돌아오고 확인은 안 돌아온다. 한 칸에 뭉개면 사이트가
  // 확인을 지움으로 읽어(안 돌아와야 할 줄이 돌아온다) 또는 그 반대로 읽어
  // (영구히 사라진다) 둘 중 하나가 깨진다.
  assert.deepEqual(feed.dismissed, dismissed);
  assert.deepEqual(feed.acknowledged, acknowledged);
  assert.ok(
    !feed.dismissed.includes(acknowledged[0]),
    "확인 열쇠가 dismissed 에 섞였다 — 사이트가 제 목록에서 영구히 빼 버린다"
  );
});

test("🔴 뺄 것이 없을 때도 칸은 있다 — 있다 없다 하면 사이트가 갈래를 따로 들어야 한다", () => {
  const feed = withOwnAcknowledgements(siteFeed(), []);
  assert.deepEqual(feed.acknowledged, []);
  assert.deepEqual(feed.dismissed, []);
});

test("🔴 못 물어봤을 때도 빈 배열이다 — 모를 때 빼면 아직 안 한 일이 안 보인다", () => {
  // 「뺄 것이 없다」와 「모른다」가 같은 값인 것은 알고 고른 것이다. 둘을 가르는
  // 표시는 `degraded` 이고, 틀렸을 때 덜 나쁜 쪽이 「한 번 더 보인다」다.
  const feed = withOwnAcknowledgements(siteFeed({ degraded: true }), []);

  assert.deepEqual(feed.acknowledged, []);
  assert.equal(feed.degraded, true, "못 물어본 것을 조용히 넘기면 안 된다");
});

test("🔴 받은 feed 를 제자리에서 고치지 않는다 — 캐시에 눌러앉는다", () => {
  const original = siteFeed({ dismissed: [`${INVENTORY}:SHIPMENT_WAIT:7`] });
  const before = { ...original, dismissed: [...original.dismissed] };

  const feed = withOwnAcknowledgements(original, [`${INVENTORY}:PARTS_LOW_STOCK_MORE`]);

  assert.notEqual(feed, original, "같은 객체를 돌려줬다");
  assert.deepEqual(original.dismissed, before.dismissed);
  assert.ok(!("acknowledged" in original), "받은 feed 에 칸을 직접 꽂았다");
});

test("🔴 거르는 조건 셋을 여기 다시 적지 않는다 — 포털 제 종과 같은 함수다", () => {
  // 두 벌이 되면 「포털 종에서는 사라졌는데 사이트 종에서는 안 사라진다」가 되고,
  // 그 증상은 이 조각이 메우려던 구멍과 똑같이 생겼다.
  const source = readFileSync("src/lib/notifications/own-acknowledgements.ts", "utf8");

  assert.ok(
    source.includes("acknowledgedItemKeys("),
    "조건 셋을 보는 일을 acknowledgedItemKeys 에 맡기지 않았다"
  );
  assert.ok(
    !source.includes("contentDigest("),
    "지문을 여기서 다시 짓는다 — 규칙이 두 벌이 되면 조용히 어긋난다"
  );
  assert.ok(
    !source.includes("purposeOf("),
    "분류 기본값을 여기서 다시 채운다 — 채우는 자리는 purposes.ts 하나다"
  );
  assert.ok(
    source.includes("parseDismissalKey("),
    "열쇠를 가르는 규칙을 다시 적었다 — 첫 `:` 하나로 가르는 함수가 따로 있다"
  );
});

test("🔴 포털은 부른 사이트에게도 묻는다 — 안 물으면 이 칸이 언제나 빈다", () => {
  // ②(지문)·③(분류)은 **그 줄 자체**가 있어야 볼 수 있는데, 내주는 목록에는
  // 부른 사이트의 줄이 없다. 이 왕복을 지우면 acknowledged 가 늘 빈 배열이 되고
  // 증상은 「재고관리에서만 확인이 안 먹힌다」 하나뿐이다.
  const source = readFileSync("src/lib/notifications/site-service.ts", "utf8");

  assert.ok(
    source.includes("ownSource ? [ownSource] : []"),
    "부른 사이트에게 묻는 자리가 사라졌다 — 그 줄이 없으면 ②·③ 을 볼 수 없다"
  );
  assert.ok(
    source.includes("ownAcknowledgedKeys("),
    "부른 사이트 제 줄에서 확인 열쇠를 고르지 않는다"
  );
  assert.ok(
    source.includes("Promise.all("),
    "둘을 차례로 묻는다 — 기다리는 시간이 합이 된다"
  );
});

test("🔴 `acknowledged` 를 얹는 자리는 한 곳이다", () => {
  const source = readFileSync("src/lib/notifications/site-service.ts", "utf8");

  // 타입(`SiteNotificationFeed`)이 「모든 반환 길에 이 칸이 있다」를 tsc 로
  // 지켜 주고, 얹는 자리를 하나로 묶어 두면 그 값이 `dismissed` 로 샐 길이 없다.
  assert.ok(
    source.includes("Promise<SiteNotificationFeed>"),
    "getSiteNotificationFeed 의 반환 타입이 바뀌었다 — 칸을 빠뜨린 길이 생긴다"
  );
  assert.ok(
    !/\backnowledged\s*:/.test(source),
    "site-service.ts 가 acknowledged 를 직접 적는다 — 얹는 자리는 withOwnAcknowledgements 하나여야 한다"
  );
});
