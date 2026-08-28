/**
 * 요청 속도 제한 — 토큰 버킷.
 *
 * server-only를 붙이지 않는다 — 판정은 순수 계산이고 단위 테스트에서 그대로
 * 불러야 한다(emergency-lockout.ts, retention.ts와 같은 이유).
 *
 * ── 왜 필요한가 ──
 *
 * 계정 잠금(emergency-lockout.ts)은 **존재하는 계정만** 지킨다. 없는 아이디로
 * 두드리면 잠금은 영원히 걸리지 않는데, emergency-login.ts는 아이디가 없어도
 * 응답 시간을 맞추려고 scrypt를 한 번 돌린다(그 자체는 옳은 방어다).
 * scrypt 1회는 이 개발 PC에서 실측 62ms, 메모리 32MB다. 제한이 없으면
 * 자격증명 없이 POST를 반복하는 것만으로 CPU를 태울 수 있고, 포털이 멈추면
 * 포털에 기대는 모든 사내 시스템의 로그인이 함께 멈춘다.
 *
 * ── 왜 토큰 버킷인가 ──
 *
 * "1분에 N회" 같은 고정 창은 창이 바뀌는 순간 2N회가 한꺼번에 통과한다.
 * 토큰 버킷은 몰아 쓰는 양(capacity)과 지속 속도(refillPerMinute)를 따로
 * 정할 수 있어, 사람의 정상적인 연타는 통과시키면서 지속적인 공격은 막는다.
 *
 * ── 왜 메모리인가 ──
 *
 * DB에 두면 요청마다 쓰기가 생겨 제한 장치 자체가 증폭기가 된다 — 막으려던
 * 것을 스스로 하는 셈이다. 대신 두 가지를 포기한다:
 *
 *   1. 재시작하면 초기화된다. 공격자가 재시작 시점을 맞출 수는 없으므로
 *      실질적 약점은 아니다.
 *   2. 프로세스가 여러 개면 각자 센다. NAS 배포는 컨테이너 1개이므로 지금은
 *      해당 없다. 여러 개로 늘릴 때는 이 파일이 아니라 리버스 프록시에서
 *      거는 것이 맞다 — 이 제한은 그 바깥 층이 생겨도 남겨 둘 안쪽 층이다.
 */

export type RateLimitPolicy = {
  /** 한 번에 몰아 쓸 수 있는 최대 요청 수. */
  capacity: number;
  /** 분당 회복량. 지속 가능한 속도가 된다. */
  refillPerMinute: number;
};

export type BucketState = {
  /** 남은 토큰. 소수점을 허용한다 — 회복이 연속적이어야 한다. */
  tokens: number;
  lastRefillMs: number;
  /**
   * 마지막으로 통과시킨 뒤 연속으로 거절한 횟수.
   *
   * 감사 로그를 위한 값이다. 거절할 때마다 로그를 쓰면 그 쓰기가 다시
   * 증폭기가 되므로, 이 값이 1일 때(= 연속 거절의 첫 건)만 기록한다.
   * 공격 한 번에 한 줄이 남는다.
   */
  rejectedSinceAllowed: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  /** 거절일 때 몇 초 뒤에 토큰 1개가 회복되는지. 통과면 0. */
  retryAfterSeconds: number;
  /** 이번 거절이 연속 거절의 첫 건인가. 감사 로그를 남길지 판단한다. */
  firstRejection: boolean;
};

export function freshBucket(policy: RateLimitPolicy, nowMs: number): BucketState {
  return { tokens: policy.capacity, lastRefillMs: nowMs, rejectedSinceAllowed: 0 };
}

/**
 * 흐른 시간만큼 토큰을 채운 상태를 돌려준다.
 *
 * 시계가 거꾸로 가는 경우(nowMs < lastRefillMs)에도 토큰이 줄지 않도록
 * 경과 시간을 0으로 깎는다. 컨테이너의 시계 보정에서 실제로 생길 수 있고,
 * 그때 사용자가 조용히 잠기면 원인을 찾기 어렵다.
 */
function refill(
  state: BucketState,
  policy: RateLimitPolicy,
  nowMs: number
): BucketState {
  const elapsedMs = Math.max(0, nowMs - state.lastRefillMs);
  const gained = (elapsedMs / 60_000) * policy.refillPerMinute;
  return {
    ...state,
    tokens: Math.min(policy.capacity, state.tokens + gained),
    lastRefillMs: nowMs,
  };
}

/**
 * 토큰 하나를 쓴다. 상태를 바꾸지 않고 **다음 상태를 돌려준다** — 시각을
 * 인자로 받는 것과 같은 이유로, 이래야 테스트가 시계에도 순서에도 기대지 않는다.
 */
export function consumeToken(
  state: BucketState,
  policy: RateLimitPolicy,
  nowMs: number
): { state: BucketState; decision: RateLimitDecision } {
  const filled = refill(state, policy, nowMs);

  if (filled.tokens >= 1) {
    return {
      state: { ...filled, tokens: filled.tokens - 1, rejectedSinceAllowed: 0 },
      decision: { allowed: true, retryAfterSeconds: 0, firstRejection: false },
    };
  }

  const rejected = filled.rejectedSinceAllowed + 1;
  // 토큰 1개가 찰 때까지 남은 시간. 올림해서 0초를 알려주지 않는다 —
  // 0초라고 답하면 클라이언트가 즉시 다시 와서 또 거절당한다.
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(((1 - filled.tokens) / policy.refillPerMinute) * 60)
  );

  return {
    state: { ...filled, rejectedSinceAllowed: rejected },
    decision: { allowed: false, retryAfterSeconds, firstRejection: rejected === 1 },
  };
}

/**
 * 버킷이 가득 찼는가 = 이 열쇠에 대해 기억할 것이 없는가.
 *
 * 가득 찬 버킷은 없는 버킷과 판정이 완전히 같다. 그래서 지워도 안전하고,
 * 아래 청소가 이 성질에 기댄다.
 */
function isForgettable(state: BucketState, policy: RateLimitPolicy): boolean {
  return state.tokens >= policy.capacity && state.rejectedSinceAllowed === 0;
}

/**
 * 열쇠 개수 상한.
 *
 * 프록시 뒤에서 열쇠는 사내 IP라 수십 개를 넘지 않는다. 그래도 상한을 두는
 * 이유: 프록시를 우회해 직접 들어온 요청은 XFF를 위조할 수 있고(client-key.ts
 * 참고), 그러면 요청마다 새 열쇠가 생겨 이 Map이 메모리를 먹는 도구가 된다.
 */
const MAX_KEYS = 10_000;

export type RateLimiter = {
  check(key: string, nowMs: number): RateLimitDecision;
  /** 테스트와 진단용. 지금 기억하고 있는 열쇠 수. */
  size(): number;
};

export function createRateLimiter(policy: RateLimitPolicy): RateLimiter {
  const buckets = new Map<string, BucketState>();

  /** 가득 찬 버킷을 버린다. 판정에 영향이 없으므로 언제 해도 안전하다. */
  function sweep(nowMs: number): void {
    for (const [key, state] of buckets) {
      if (isForgettable(refill(state, policy, nowMs), policy)) {
        buckets.delete(key);
      }
    }
  }

  return {
    check(key, nowMs) {
      if (buckets.size >= MAX_KEYS && !buckets.has(key)) {
        sweep(nowMs);
        // 청소하고도 자리가 없다면 실제로 그만큼의 서로 다른 출처가
        // 두드리고 있다는 뜻이다. 새 열쇠를 만들어 주는 대신 거절한다 —
        // 여기서 자리를 내주면 메모리가 공격 수단이 된다.
        if (buckets.size >= MAX_KEYS) {
          return { allowed: false, retryAfterSeconds: 60, firstRejection: false };
        }
      }

      const current = buckets.get(key) ?? freshBucket(policy, nowMs);
      const { state, decision } = consumeToken(current, policy, nowMs);
      buckets.set(key, state);
      return decision;
    },
    size() {
      return buckets.size;
    },
  };
}
