import assert from "node:assert/strict";
import { test } from "node:test";
import { isMoveDirection, moveOneStep, renumber } from "./client-order";

const IDS = ["meters", "as", "hr"] as const;

test("위로 옮기면 바로 위와 자리를 바꾼다", () => {
  assert.deepEqual(moveOneStep(IDS, "as", "up"), ["as", "meters", "hr"]);
});

test("아래로 옮기면 바로 아래와 자리를 바꾼다", () => {
  assert.deepEqual(moveOneStep(IDS, "as", "down"), ["meters", "hr", "as"]);
});

test("맨 위에서 위로, 맨 아래에서 아래로는 옮기지 않는다", () => {
  assert.equal(moveOneStep(IDS, "meters", "up"), null);
  assert.equal(moveOneStep(IDS, "hr", "down"), null);
});

test("목록에 없는 시스템은 옮기지 않는다", () => {
  // 화면을 연 사이에 누가 시스템을 지웠거나, 폼 값을 손으로 바꾼 경우다.
  assert.equal(moveOneStep(IDS, "nope", "up"), null);
  assert.equal(moveOneStep([], "as", "down"), null);
});

test("받은 목록을 건드리지 않는다", () => {
  const ids = ["meters", "as"];
  moveOneStep(ids, "as", "up");
  assert.deepEqual(ids, ["meters", "as"]);
});

test("차례 그대로 10 간격으로 매긴다", () => {
  assert.deepEqual(
    [...renumber(["as", "meters", "hr"])],
    [
      ["as", 10],
      ["meters", 20],
      ["hr", 30],
    ]
  );
});

test("아홉 개까지는 새로 등록된 시스템이 맨 뒤에 붙는다", () => {
  // 100은 schema/clients.ts의 sort_order 기본값이다.
  const ids = Array.from({ length: 9 }, (_, i) => `c${i}`);
  const last = Math.max(...renumber(ids).values());
  assert.ok(last < 100, `마지막 값 ${last}이(가) 기본값 100보다 작아야 한다`);
});

test("방향 값은 up·down 둘만 받는다", () => {
  assert.equal(isMoveDirection("up"), true);
  assert.equal(isMoveDirection("down"), true);
  for (const bad of ["", "UP", "left", "top"]) {
    assert.equal(isMoveDirection(bad), false, bad);
  }
});
