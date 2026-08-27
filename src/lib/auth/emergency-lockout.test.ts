import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterFailure,
  CLEARED_LOCK_STATE,
  isLocked,
  LOCK_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
  minutesUntilUnlock,
} from "./emergency-lockout";

const NOW = new Date("2026-08-27T09:00:00.000Z");

test("잠금 시각이 없으면 잠긴 것이 아니다", () => {
  assert.equal(isLocked(CLEARED_LOCK_STATE, NOW), false);
  assert.equal(isLocked({ failedAttempts: 4, lockedUntil: null }, NOW), false);
});

test("잠금 시각이 지나면 스스로 풀린다", () => {
  const justPast = new Date(NOW.getTime() - 1);
  assert.equal(isLocked({ failedAttempts: 0, lockedUntil: justPast }, NOW), false);

  const justFuture = new Date(NOW.getTime() + 1);
  assert.equal(isLocked({ failedAttempts: 0, lockedUntil: justFuture }, NOW), true);
});

test("한도에 못 미치는 실패는 세기만 하고 잠그지 않는다", () => {
  let state = CLEARED_LOCK_STATE;
  for (let i = 1; i < MAX_FAILED_ATTEMPTS; i += 1) {
    state = afterFailure(state, NOW);
    assert.equal(state.failedAttempts, i);
    assert.equal(state.lockedUntil, null);
  }
});

test("한도째 실패에서 잠기고, 그때 실패 횟수는 0으로 돌아간다", () => {
  let state = CLEARED_LOCK_STATE;
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
    state = afterFailure(state, NOW);
  }

  assert.equal(isLocked(state, NOW), true);
  assert.equal(state.lockedUntil?.getTime(), NOW.getTime() + LOCK_DURATION_MS);
  // 잠금이 풀린 뒤 실패 한 번에 또 잠기면 사실상 영구 잠금이 된다.
  assert.equal(state.failedAttempts, 0);
});

test("잠금이 풀린 뒤에는 다시 처음부터 센다", () => {
  let state = CLEARED_LOCK_STATE;
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
    state = afterFailure(state, NOW);
  }

  const afterUnlock = new Date(NOW.getTime() + LOCK_DURATION_MS + 1);
  assert.equal(isLocked(state, afterUnlock), false);

  const next = afterFailure(state, afterUnlock);
  assert.equal(next.failedAttempts, 1);
  assert.equal(next.lockedUntil, null);
});

test("남은 시간은 올림하고 최소 1분으로 알린다", () => {
  assert.equal(minutesUntilUnlock(CLEARED_LOCK_STATE, NOW), 0);

  const past = { failedAttempts: 0, lockedUntil: new Date(NOW.getTime() - 1) };
  assert.equal(minutesUntilUnlock(past, NOW), 0);

  // 1초 남았어도 "0분 뒤"라고 하면 사람이 즉시 다시 눌러 또 실패한다.
  const oneSecond = { failedAttempts: 0, lockedUntil: new Date(NOW.getTime() + 1000) };
  assert.equal(minutesUntilUnlock(oneSecond, NOW), 1);

  const full = { failedAttempts: 0, lockedUntil: new Date(NOW.getTime() + LOCK_DURATION_MS) };
  assert.equal(minutesUntilUnlock(full, NOW), 15);

  const tenAndHalf = {
    failedAttempts: 0,
    lockedUntil: new Date(NOW.getTime() + 10.5 * 60_000),
  };
  assert.equal(minutesUntilUnlock(tenAndHalf, NOW), 11);
});
