/**
 * ============================================================================
 * 사람마다 따로, 아주 짧게 — 통합 알림 캐시
 * ============================================================================
 * 종은 자주 열린다. 캐시가 없으면 열 때마다 시스템 수만큼 요청이 나가고, 각
 * 시스템은 그 한 번에 여러 조회를 돈다(A/S 의 listMyNotifications 는 최대 8번).
 * 설계서 E절이 「포털에 캐시가 필요하다」고 적은 자리다.
 *
 * 🔴 **열쇠에 사람이 들어가야 한다.** 안 넣으면 먼저 연 사람의 알림이 다음
 * 사람에게 그대로 보인다 — 이 파일에서 가장 위험한 한 줄이고, 시험으로 못
 * 박아 두었다.
 *
 * ── 왜 메모리인가 ──
 * rate-limit.ts 와 같은 판단이다. DB 에 두면 종을 열 때마다 쓰기가 생겨 캐시가
 * 부하를 줄이는 대신 만들어 낸다. 재시작하면 비지만, 비어 있음 = 한 번 더 물음
 * 이라 손해가 없다. 프로세스가 여럿이면 각자 갖는데, NAS 배포는 컨테이너 하나다.
 *
 * 🔴 그리고 이것은 **저장이 아니다.** 설계서 D-2 가 버린 길은 알림을 포털 DB 에
 * 쌓는 것이고, 여기 있는 것은 수십 초 뒤 사라지는 사본이다.
 *
 * 시각을 인자로 받는다 — rate-limit.ts 와 같은 이유로, 시험이 시계에 기대지
 * 않아야 한다.
 * ============================================================================
 */

export type UserCache<T> = {
  /** 살아 있는 값이 있으면 그것, 없거나 상했으면 null. */
  get(userId: string, nowMs: number): T | null;
  /**
   * `ttlMs` 를 주면 이 값만 그만큼 들고 있는다.
   *
   * 무엇에 쓰나: 한 시스템을 못 물어봤을 때의 답은 **짧게** 들고 있어야 한다.
   * 안 들고 있으면 죽은 시스템이 살아날 때까지 종을 열 때마다 타임아웃을 한
   * 번씩 기다리게 되고(= 모두에게 느려진다), 평소만큼 오래 들고 있으면 저쪽이
   * 살아난 뒤에도 한참 빈 채로 보인다.
   */
  set(userId: string, value: T, nowMs: number, ttlMs?: number): void;
  /** 그 사람 것만 버린다. 설정을 저장한 직후처럼 값이 바뀐 것을 아는 순간에 쓴다. */
  invalidate(userId: string): void;
  /** 시험·진단용. 지금 들고 있는 사람 수. */
  size(): number;
};

export type UserCacheOptions = {
  /**
   * 얼마나 들고 있을 것인가.
   *
   * 짧아야 한다. 결재를 처리하고 종을 다시 열었는데 처리한 일이 그대로 남아
   * 있으면 「알림이 안 사라진다」로 보인다 — A/S 가 공짜로 얻고 있는 성질
   * (처리하면 사라진다)을 포털이 캐시로 깨는 셈이다. 30초면 1분 폴링의 절반이라
   * 사람이 느끼는 지연은 거의 없고, 연타로 들어오는 요청은 흡수한다.
   */
  ttlMs: number;
  /**
   * 기억할 사람 수 상한.
   *
   * 사내 인원이라 수십 명을 넘지 않지만, 상한 없는 Map 은 장수 프로세스에서
   * 언젠가 문제가 된다(rate-limit.ts 의 MAX_KEYS 와 같은 판단).
   */
  maxUsers: number;
};

type Entry<T> = { value: T; expiresAtMs: number };

export function createUserCache<T>(options: UserCacheOptions): UserCache<T> {
  const entries = new Map<string, Entry<T>>();

  /** 상한 값을 버린다. 판정에 영향이 없으므로 언제 해도 안전하다. */
  function sweep(nowMs: number): void {
    for (const [userId, entry] of entries) {
      if (entry.expiresAtMs <= nowMs) entries.delete(userId);
    }
  }

  return {
    get(userId, nowMs) {
      const entry = entries.get(userId);
      if (!entry) return null;
      if (entry.expiresAtMs <= nowMs) {
        entries.delete(userId);
        return null;
      }
      return entry.value;
    },

    set(userId, value, nowMs, ttlMs) {
      if (entries.size >= options.maxUsers && !entries.has(userId)) {
        sweep(nowMs);
        // 청소하고도 자리가 없으면 **캐시하지 않고 넘어간다.** 남의 자리를
        // 빼앗지 않는다 — 캐시가 없어도 답은 나오고(한 번 더 물을 뿐),
        // 여기서 무리하면 메모리가 공격 수단이 된다.
        if (entries.size >= options.maxUsers) return;
      }
      entries.set(userId, { value, expiresAtMs: nowMs + (ttlMs ?? options.ttlMs) });
    },

    invalidate(userId) {
      entries.delete(userId);
    },

    size() {
      return entries.size;
    },
  };
}
