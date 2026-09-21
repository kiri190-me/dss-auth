import "server-only";
import { getIssuer } from "@/lib/config/env";
import { getSigningKey } from "@/lib/crypto/keys";
import { listAccessibleClients } from "@/lib/db/queries/clients";
import { signPortalServiceToken } from "@/lib/oidc/service-token";
import { createUserCache } from "./cache";
import { gatherNotifications, type SignServiceToken } from "./gather";
import { emptyFeed, type PortalNotificationFeed } from "./merge";
import { siteFeedCacheKey } from "./site-feed";
import { toNotificationSources } from "./sources";

/**
 * ============================================================================
 * 사이트가 물었을 때 무엇을 모아 줄 것인가
 * ============================================================================
 * service.ts 의 `getNotificationFeed(userId)` 와 하는 일이 같다 — 다른 것은
 * 하나뿐이다:
 *
 *   🔴 **부른 사이트 자신에게는 묻지 않는다.**
 *
 * ── 왜 빼는가 (판단과 까닭) ────────────────────────────────────────────────
 * A/S 가 물었을 때 A/S 알림까지 돌려주면 이렇게 된다:
 *
 *   A/S 의 layout → 포털 → **A/S 의 /api/integration/notifications**
 *
 * 되돌기다. 넷 다 실제로 나쁘다:
 *
 *  1. **자기가 이미 아는 것을 한 바퀴 돌아 받는다.** A/S 는 그 목록을 지금도
 *     자기 DB 에서 바로 계산한다(listMyNotifications). 같은 값을 얻으려고
 *     포털을 거쳐 자기 자신을 다시 부르는 셈이다.
 *  2. 🔴 **「처리하면 사라진다」가 깨진다.** 포털은 30초 캐시를 든다. 사람이
 *     결재를 처리하고 화면을 다시 그렸는데 방금 처리한 줄이 30초 동안 종에
 *     그대로 남는다. A/S 가 공짜로 갖고 있던 성질을, **사람이 지금 일하고 있는
 *     바로 그 시스템에서** 포털이 깨는 것이다. 남의 시스템 알림이 30초 늦는
 *     것은 괜찮다(거기서 일하고 있지 않으니까). 자기 것이 늦는 것은 다르다.
 *  3. **포털이 죽으면 자기 알림까지 사라진다.** 빼 두면 사이트는 제 알림을
 *     늘 제 손으로 그리므로, 포털이 죽어도 종은 「남의 시스템 것만 빠진」
 *     상태로 산다. 설계서 E절이 치르는 값으로 적어 둔 것을 절반 돌려받는다.
 *  4. **화면 한 장에 왕복이 하나 는다.** layout 이 서버에서 기다리는 시간이다.
 *
 * 그래서 이 통로는 **각 시스템에 묻는 일을 하지 않는 경우**를 갖는다. 오늘
 * 실제로 그렇다 — 알림 통로를 가진 시스템이 A/S 하나뿐이라(sources.ts),
 * **A/S 가 물으면 포털은 아무에게도 묻지 않고** 빈 목록을 돌려준다. 그것이
 * 맞는 답이다. 값어치는 두 번째 시스템이 붙는 날부터 나온다 — 그리고 알림이
 * 없는 사이트(PO·계측기·개선요청)는 **오늘도** 이 통로로 A/S 알림을 받는다.
 *
 * ⚠️ 그 대신 **사이트가 자기 알림을 스스로 얹어야 한다.** 받은 목록에 제
 * 목록을 이어 붙이고 개수를 더한다(그 모양은 merge.ts 의 아홉 칸, 곧
 * `@dss/ui` 의 NotificationBellItem 과 같다). docs/사이트-알림-통로.md 에
 * 적어 두었다.
 * ============================================================================
 */

/**
 * 🔴 아래 세 상수와 두 도우미는 service.ts 와 **같은 값·같은 모양**이다.
 *
 * 왜 베끼는가: 저쪽은 앞 조각이 시험 92개로 붙들고 있는 파일이고, 이번 조각은
 * 그것을 고치지 않는 것이 규칙이다. 그리고 실제로 하나로 합칠 수 없다 —
 * 저쪽은 「모든 시스템에」 묻고 여기는 「하나를 뺀 나머지에」 묻는다. 합치려면
 * service.ts 의 서명이 바뀌어야 한다.
 *
 * 🔴 값을 바꿀 일이 생기면 **두 곳을 함께** 바꿔야 한다. 어긋나면 포털의 종과
 * 사이트의 종이 서로 다른 나이의 답을 보여 준다.
 */
const FEED_TTL_MS = 30_000;
const DEGRADED_TTL_MS = 5_000;

/**
 * 기억할 (사이트 × 사람) 수.
 *
 * service.ts 가 사람만 세는 것과 달리 여기는 짝을 센다. 사내 인원 수십 명 ×
 * 시스템 다섯이라 실제로는 수백을 넘지 않고, 자리가 없으면 캐시를 건너뛸 뿐
 * 답은 그대로 나온다(cache.ts).
 */
const MAX_CACHED_PAIRS = 1_000;

const siteFeedCache = createUserCache<PortalNotificationFeed>({
  ttlMs: FEED_TTL_MS,
  maxUsers: MAX_CACHED_PAIRS,
});

/** 이 사람의 이름으로 서명한다. subject 를 여기서 한 번 닫아 둔다. */
function signerFor(subject: string): SignServiceToken {
  return async ({ audience, purpose }) => {
    const { key, kid } = await getSigningKey();
    return signPortalServiceToken({
      issuer: getIssuer(),
      audience,
      subject,
      purpose,
      key,
      kid,
    });
  };
}

/**
 * 사이트에 내줄 「이 사람의 지금 알림」.
 *
 * 🔴 **던지지 않는다.** 이 값을 기다리는 것은 남의 사이트의 layout 이다 —
 * 여기서 터지면 그 사이트의 화면이 통째로 안 뜬다(설계서 F-8 의 그 줄이
 * 한 칸 더 밖으로 나온 자리다).
 */
export async function getSiteNotificationFeed(params: {
  userId: string;
  /** 🔴 부른 사이트. 이 시스템에는 묻지 않는다. */
  exceptClientId: string;
}): Promise<PortalNotificationFeed> {
  const key = siteFeedCacheKey(params.exceptClientId, params.userId);
  const cached = siteFeedCache.get(key, Date.now());
  if (cached) return cached;

  let feed: PortalNotificationFeed;
  try {
    const { sources, skipped } = toNotificationSources(await listAccessibleClients(params.userId));
    for (const row of skipped) {
      console.error(
        `[notifications] ${row.clientId} 의 launcher_url 이 ${row.reason} 이라 물어볼 수 없습니다. npm run client:register 로 등록하세요.`
      );
    }

    feed = await gatherNotifications({
      // 🔴 **거르고 나서** 묻는다. 받아 온 뒤에 빼면 늦다 — 그때는 이미
      // 되돌기(포털 → 부른 사이트)가 일어난 뒤다.
      sources: sources.filter((source) => source.clientId !== params.exceptClientId),
      signToken: signerFor(params.userId),
    });
  } catch (error) {
    console.error("[notifications] 사이트에 내줄 알림을 모으지 못했습니다:", error);
    return { ...emptyFeed(), degraded: true };
  }

  siteFeedCache.set(key, feed, Date.now(), feed.degraded ? DEGRADED_TTL_MS : undefined);
  return feed;
}
