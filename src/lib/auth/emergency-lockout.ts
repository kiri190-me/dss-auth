/**
 * 비상 계정 잠금 정책.
 *
 * server-only를 붙이지 않는다 — 순수 함수라 단위 테스트에서 그대로 부를 수
 * 있어야 한다(crypto/hash.ts와 같은 이유). DB를 만지는 쪽은
 * emergency-login.ts가 맡는다.
 *
 * 왜 잠그는가: 비상 계정은 카카오를 거치지 않는 유일한 통로라, 카카오가
 * 제공하던 무차별 대입 방어가 없다. scrypt가 한 번에 수십 ms를 쓰지만
 * 그것만으로는 며칠에 걸친 시도를 막지 못한다.
 */

/** 이 횟수만큼 연속으로 틀리면 잠근다. */
export const MAX_FAILED_ATTEMPTS = 5;

/**
 * 잠금 시간 15분.
 *
 * 짧게 잡은 이유: 이 계정이 쓰이는 상황은 "카카오가 죽어서 아무도 못
 * 들어가는" 순간이다. 그때 오타 몇 번으로 한 시간을 잠그면 잠금 장치가
 * 사고를 키운다. 15분이면 무차별 대입은 사실상 불가능해지고(시도당
 * 5회/15분), 사람은 커피 한 잔 시간에 다시 시도할 수 있다.
 */
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export type LockState = {
  failedAttempts: number;
  lockedUntil: Date | null;
};

/** 실패도 성공도 없던 상태. 성공하면 여기로 돌아간다. */
export const CLEARED_LOCK_STATE: LockState = {
  failedAttempts: 0,
  lockedUntil: null,
};

export function isLocked(state: LockState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/**
 * 비밀번호가 틀렸을 때의 다음 상태.
 *
 * 잠글 때 failedAttempts를 0으로 되돌리는 것이 핵심이다. 잠금이 풀린 뒤에는
 * 다시 5번의 기회에서 시작해야 한다 — 그러지 않으면 한 번 잠긴 계정은 이후
 * 실패 한 번마다 계속 잠기는 사실상 영구 잠금이 된다.
 */
export function afterFailure(state: LockState, now: Date): LockState {
  const attempts = state.failedAttempts + 1;

  if (attempts >= MAX_FAILED_ATTEMPTS) {
    return {
      failedAttempts: 0,
      lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS),
    };
  }

  return { failedAttempts: attempts, lockedUntil: null };
}

/** 잠금이 언제 풀리는지 사람에게 알려줄 남은 분. 최소 1분으로 올린다. */
export function minutesUntilUnlock(state: LockState, now: Date): number {
  if (!state.lockedUntil) return 0;
  const remaining = state.lockedUntil.getTime() - now.getTime();
  if (remaining <= 0) return 0;
  return Math.max(1, Math.ceil(remaining / 60_000));
}
