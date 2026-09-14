/**
 * 연결된 시스템의 표시 순서를 옮기는 규칙.
 *
 * server-only를 붙이지 않는다 — 순수 함수이고, 판정을 테스트로 고정해야 한다
 * (audit-labels.ts와 같은 이유).
 *
 * 이 순서는 직원들이 보는 시스템 목록(/apps)의 타일과 사용자 관리의
 * 「시스템 접근·역할」 칸이 함께 쓴다. 누가 어디에 들어갈 수 있는지와는
 * 아무 관계가 없다 — 보이는 차례일 뿐이다.
 */

export type MoveDirection = "up" | "down";

/** 폼에서 온 값은 믿지 않는다. 서버 액션은 화면을 거치지 않고도 불린다. */
export function isMoveDirection(value: string): value is MoveDirection {
  return value === "up" || value === "down";
}

/**
 * 화면에 보이는 차례대로 늘어선 ID 목록에서 하나를 한 칸 옮긴 새 목록.
 *
 * 옮길 수 없으면 null — 맨 위에서 더 올리거나, 목록에 없는 ID가 왔을 때다.
 * 호출부가 "이미 맨 위입니다"처럼 알린다. 받은 배열은 건드리지 않는다.
 */
export function moveOneStep(
  ids: readonly string[],
  id: string,
  direction: MoveDirection
): string[] | null {
  const from = ids.indexOf(id);
  if (from === -1) return null;

  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= ids.length) return null;

  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export const SORT_ORDER_STEP = 10;

/**
 * 목록 차례 그대로 10, 20, 30…을 매긴다.
 *
 * 두 행의 값만 맞바꾸지 않고 매번 전체를 다시 매기는 이유: 값이 같은 행
 * (등록 기본값 100)끼리는 이름순으로 놓이는데, 그 이름순은 DB의 콜레이션이
 * 정한다 — 한글과 영문 중 무엇이 먼저인지를 우리가 고른 적이 없다. 한 번
 * 매겨 두면 차례가 값에만 달린다.
 *
 * 간격을 10으로 두는 이유: 새로 등록되는 시스템은 기본값 100을 받으므로,
 * 시스템이 아홉 개까지는 저절로 맨 뒤에 붙는다.
 */
export function renumber(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, (index + 1) * SORT_ORDER_STEP]));
}
