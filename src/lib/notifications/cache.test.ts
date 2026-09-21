import assert from "node:assert/strict";
import { test } from "node:test";
import { createUserCache } from "./cache";

const T0 = 1_700_000_000_000;

function cache(over: { ttlMs?: number; maxUsers?: number } = {}) {
  return createUserCache<string>({
    ttlMs: over.ttlMs ?? 30_000,
    maxUsers: over.maxUsers ?? 500,
  });
}

test("🔴 사람마다 갈린다 — 남의 알림이 보이지 않는다", () => {
  // 이 파일에서 가장 위험한 한 줄이다. 열쇠에 사람을 안 넣으면 먼저 종을 연
  // 사람의 알림이 다음 사람에게 그대로 보인다.
  const store = cache();
  store.set("희만", "희만의 알림", T0);
  store.set("영희", "영희의 알림", T0);

  assert.equal(store.get("희만", T0), "희만의 알림");
  assert.equal(store.get("영희", T0), "영희의 알림");
  assert.equal(store.get("철수", T0), null);
});

test("🔴 한 사람만 캐시돼 있을 때 다른 사람은 빈손으로 돌아간다", () => {
  const store = cache();
  store.set("희만", "희만의 알림", T0);
  // 여기서 값이 나오면 그 순간 남의 알림이 새는 것이다.
  assert.equal(store.get("영희", T0), null);
});

test("수명이 지나면 없는 것이 된다", () => {
  const store = cache({ ttlMs: 30_000 });
  store.set("희만", "값", T0);
  assert.equal(store.get("희만", T0 + 29_999), "값");
  assert.equal(store.get("희만", T0 + 30_000), null);
});

test("상한 수명을 따로 줄 수 있다 — 못 물어본 답은 짧게 든다", () => {
  const store = cache({ ttlMs: 30_000 });
  store.set("희만", "반쪽짜리", T0, 5_000);
  assert.equal(store.get("희만", T0 + 4_999), "반쪽짜리");
  assert.equal(store.get("희만", T0 + 5_000), null);
});

test("그 사람 것만 버린다", () => {
  const store = cache();
  store.set("희만", "ㄱ", T0);
  store.set("영희", "ㄴ", T0);
  store.invalidate("희만");
  assert.equal(store.get("희만", T0), null);
  assert.equal(store.get("영희", T0), "ㄴ");
});

test("같은 사람을 다시 담으면 덮어쓴다", () => {
  const store = cache();
  store.set("희만", "옛 값", T0);
  store.set("희만", "새 값", T0 + 1000);
  assert.equal(store.get("희만", T0 + 1000), "새 값");
  assert.equal(store.size(), 1);
});

test("상한에 닿으면 상한 값을 먼저 버린다", () => {
  const store = cache({ ttlMs: 1_000, maxUsers: 2 });
  store.set("ㄱ", "1", T0);
  store.set("ㄴ", "2", T0);
  // 둘 다 상했을 시점에 새 사람이 온다 — 청소하고 자리를 낸다.
  store.set("ㄷ", "3", T0 + 2_000);
  assert.equal(store.get("ㄷ", T0 + 2_000), "3");
  assert.equal(store.size(), 1);
});

test("자리가 없으면 캐시하지 않을 뿐, 남의 자리를 빼앗지 않는다", () => {
  const store = cache({ ttlMs: 60_000, maxUsers: 2 });
  store.set("ㄱ", "1", T0);
  store.set("ㄴ", "2", T0);
  store.set("ㄷ", "3", T0);

  assert.equal(store.get("ㄷ", T0), null);
  assert.equal(store.get("ㄱ", T0), "1");
  assert.equal(store.get("ㄴ", T0), "2");
});

test("상한 값을 꺼내면 그 자리도 비운다", () => {
  const store = cache({ ttlMs: 1_000 });
  store.set("희만", "값", T0);
  assert.equal(store.get("희만", T0 + 2_000), null);
  assert.equal(store.size(), 0);
});
