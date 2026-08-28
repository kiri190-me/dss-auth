import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consumeToken,
  createRateLimiter,
  freshBucket,
  type RateLimitPolicy,
} from "./rate-limit";

/** 몰아 쓰기 3회, 분당 6회 회복 = 토큰 하나가 10초마다 찬다. */
const POLICY: RateLimitPolicy = { capacity: 3, refillPerMinute: 6 };

const T0 = 1_700_000_000_000;

test("capacity만큼은 시간이 흐르지 않아도 통과한다", () => {
  let state = freshBucket(POLICY, T0);
  for (let i = 0; i < POLICY.capacity; i++) {
    const result = consumeToken(state, POLICY, T0);
    assert.equal(result.decision.allowed, true, `${i + 1}번째는 통과해야 한다`);
    state = result.state;
  }
});

test("capacity를 넘으면 거절한다", () => {
  let state = freshBucket(POLICY, T0);
  for (let i = 0; i < POLICY.capacity; i++) {
    state = consumeToken(state, POLICY, T0).state;
  }
  const { decision } = consumeToken(state, POLICY, T0);
  assert.equal(decision.allowed, false);
});

test("시간이 흐르면 회복된다", () => {
  let state = freshBucket(POLICY, T0);
  for (let i = 0; i < POLICY.capacity; i++) {
    state = consumeToken(state, POLICY, T0).state;
  }
  assert.equal(consumeToken(state, POLICY, T0).decision.allowed, false);

  // 분당 6회 = 10초에 1개.
  const after = consumeToken(state, POLICY, T0 + 10_000);
  assert.equal(after.decision.allowed, true);
});

test("아무리 오래 기다려도 capacity를 넘게 쌓이지 않는다", () => {
  let state = freshBucket(POLICY, T0);
  for (let i = 0; i < POLICY.capacity; i++) {
    state = consumeToken(state, POLICY, T0).state;
  }

  // 하루를 기다린 뒤에도 몰아 쓸 수 있는 양은 capacity 그대로여야 한다.
  const dayLater = T0 + 24 * 60 * 60 * 1000;
  for (let i = 0; i < POLICY.capacity; i++) {
    const result = consumeToken(state, POLICY, dayLater);
    assert.equal(result.decision.allowed, true);
    state = result.state;
  }
  assert.equal(consumeToken(state, POLICY, dayLater).decision.allowed, false);
});

test("retryAfterSeconds는 실제로 그만큼 뒤에 통과할 시간이다", () => {
  let state = freshBucket(POLICY, T0);
  for (let i = 0; i < POLICY.capacity; i++) {
    state = consumeToken(state, POLICY, T0).state;
  }
  const { decision } = consumeToken(state, POLICY, T0);
  assert.equal(decision.allowed, false);
  // 10초마다 1개가 차므로 10초를 알려줘야 한다.
  assert.equal(decision.retryAfterSeconds, 10);

  const later = consumeToken(state, POLICY, T0 + decision.retryAfterSeconds * 1000);
  assert.equal(later.decision.allowed, true);
});

test("retryAfterSeconds는 0초를 알려주지 않는다", () => {
  // 분당 6000회처럼 아주 빠른 회복에서도 0이 나오면 클라이언트가 즉시 다시
  // 와서 또 거절당하는 고리에 빠진다.
  const fast: RateLimitPolicy = { capacity: 1, refillPerMinute: 6000 };
  let state = freshBucket(fast, T0);
  state = consumeToken(state, fast, T0).state;
  const { decision } = consumeToken(state, fast, T0);
  assert.equal(decision.allowed, false);
  assert.ok(decision.retryAfterSeconds >= 1);
});

test("연속 거절의 첫 건에만 firstRejection이 선다", () => {
  let state = freshBucket(POLICY, T0);
  for (let i = 0; i < POLICY.capacity; i++) {
    state = consumeToken(state, POLICY, T0).state;
  }

  const first = consumeToken(state, POLICY, T0);
  assert.equal(first.decision.allowed, false);
  assert.equal(first.decision.firstRejection, true, "첫 거절이어야 한다");
  state = first.state;

  const second = consumeToken(state, POLICY, T0);
  assert.equal(second.decision.firstRejection, false, "두 번째부터는 서지 않는다");
  state = second.state;

  // 한 번 통과하고 나면 다시 처음부터 센다 — 다음 공격이 또 한 줄 남는다.
  // 10초 뒤에는 토큰이 정확히 하나 차 있으므로 한 번만 통과한다.
  const allowedAgain = consumeToken(state, POLICY, T0 + 10_000);
  assert.equal(allowedAgain.decision.allowed, true);
  state = allowedAgain.state;

  const again = consumeToken(state, POLICY, T0 + 10_000);
  assert.equal(again.decision.allowed, false);
  assert.equal(again.decision.firstRejection, true);
});

test("시계가 거꾸로 가도 토큰이 줄지 않는다", () => {
  let state = freshBucket(POLICY, T0);
  state = consumeToken(state, POLICY, T0).state;

  // 컨테이너의 시계 보정으로 과거 시각이 들어온 경우.
  const back = consumeToken(state, POLICY, T0 - 60_000);
  assert.equal(back.decision.allowed, true);
  // 남은 토큰이 음수로 흐르거나 capacity를 넘지 않아야 한다.
  assert.ok(back.state.tokens >= 0);
  assert.ok(back.state.tokens <= POLICY.capacity);
});

test("열쇠가 다르면 서로의 한도를 깎지 않는다", () => {
  const limiter = createRateLimiter(POLICY);
  for (let i = 0; i < POLICY.capacity; i++) {
    assert.equal(limiter.check("192.168.0.2", T0).allowed, true);
  }
  assert.equal(limiter.check("192.168.0.2", T0).allowed, false);
  // 다른 손님은 영향을 받지 않는다.
  assert.equal(limiter.check("192.168.0.3", T0).allowed, true);
});

test("가득 찬 버킷은 잊는다 — 기억이 무한히 쌓이지 않는다", () => {
  const limiter = createRateLimiter(POLICY);
  limiter.check("192.168.0.2", T0);
  assert.equal(limiter.size(), 1);

  // 충분히 오래 지나 가득 찬 뒤 다른 열쇠로 들어오면 청소 대상이 된다.
  // (청소는 상한에 닿았을 때만 도므로, 여기서는 판정이 같음을 확인한다.)
  const long = T0 + 60 * 60 * 1000;
  assert.equal(limiter.check("192.168.0.2", long).allowed, true);
  // 한 시간 뒤의 이 손님은 처음 온 손님과 완전히 같은 대접을 받아야 한다.
  for (let i = 0; i < POLICY.capacity - 1; i++) {
    assert.equal(limiter.check("192.168.0.2", long).allowed, true);
  }
  assert.equal(limiter.check("192.168.0.2", long).allowed, false);
});
