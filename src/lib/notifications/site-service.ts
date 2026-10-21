import "server-only";
import { getIssuer } from "@/lib/config/env";
import { getSigningKey } from "@/lib/crypto/keys";
import { listAccessibleClients } from "@/lib/db/queries/clients";
import { listAcknowledgedDigests } from "@/lib/db/queries/notification-acknowledgements";
import { listDismissedKeys } from "@/lib/db/queries/notification-dismissals";
import { listKindPurposesByClient } from "@/lib/db/queries/notification-kind-purposes";
import { signPortalServiceToken } from "@/lib/oidc/service-token";
import { applyAcknowledgements, sourceIdsOf } from "./acknowledgements";
import { createUserCache } from "./cache";
import { applySiteDismissals, type SiteDismissalFeed } from "./dismissals";
import { gatherNotifications, type SignServiceToken } from "./gather";
import { emptyFeed, type PortalNotificationFeed } from "./merge";
import {
  ownAcknowledgedKeys,
  withOwnAcknowledgements,
  type SiteNotificationFeed,
} from "./own-acknowledgements";
import { siteFeedCacheKey } from "./site-feed";
import { toNotificationSources } from "./sources";

/**
 * ============================================================================
 * 사이트가 물었을 때 무엇을 모아 줄 것인가
 * ============================================================================
 * service.ts 의 `getNotificationFeed(userId)` 와 하는 일이 같다 — 다른 것은
 * 하나뿐이다:
 *
 *   🔴 **부른 사이트 자신의 알림은 내주지 않는다.**
 *
 * ⚠️ **2026-10-22 에 한 낱말이 달라졌다.** 전에는 「**묻지** 않는다」였는데 지금은
 * 「**내주지** 않는다」다. 포털은 부른 사이트에게도 한 번 묻되, 받아 온 줄은
 * `items`·`count`·`sources` 어디에도 넣지 않고 **확인(✓) 열쇠를 가리는 데만** 쓴다.
 * 까닭과 실측은 아래 「🔴 부른 사이트에게도 묻는다」 절에 있다. 내주는 모양은
 * 그대로이므로 **사이트가 받는 것은 달라지지 않는다**(칸 하나가 늘 뿐이다).
 *
 * ── 왜 내주지 않는가 (판단과 까닭) ─────────────────────────────────────────
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
 *
 * ── 🔴 부른 사이트에게도 묻는다 — 확인(✓) 열쇠를 가리려고만 (2026-10-22) ────
 * 사이트가 제 알림을 ✓ 로 거르려면 포털이 **뺄 열쇠**를 알려 줘야 하는데, 그
 * 판정은 조건 셋이 모두 맞아야 한다(acknowledgements.ts): ① 기록이 있고
 * ② **지문이 지금 내용과 같고** ③ 분류가 `INFO` 다. ②·③ 은 **그 줄 자체**가
 * 있어야 볼 수 있고, 그 줄은 위 네 까닭 때문에 이 목록에 없다. 그래서 한 번
 * 묻는다. 길의 비교와 (나)를 버린 까닭은 own-acknowledgements.ts 머리말에 있다.
 *
 * 🔴 **되돌기(무한 호출)는 생기지 않는다 — 코드로 확인했다.** 각 사이트가 포털에
 * 내주는 `/api/integration/notifications`(GET · 포털 서명 Bearer)는 **제 DB 만**
 * 읽는다. 실제로 열어 확인한 곳 넷: RF_Service_System(`listMyNotifications`) ·
 * dss-improvements(`listOwnNotifications`) · dss-leave(`pendingApprovalNotifications`)
 * · dss-board(공지 조회 둘). 포털을 되부르는 곳이 한 군데도 없다. 🔵 그리고 그것은
 * **오늘 이미 참이어야 하는 성질**이다 — 포털 제 종(`getNotificationFeed`)이 평소
 * 그 통로들을 전부 두드리고 있으므로, 어느 하나라도 포털을 되부르면 오늘도 벌써
 * 무한히 돌았을 것이다. 여기서 느는 것은 **부른 사이트 하나**뿐이고 깊이는 1 이다.
 *
 * 🔴 **왕복은 하나 는다. 기다리는 시간은 거의 안 는다 — 재서 확인했다.**
 * `gatherNotifications` 는 시스템들을 `Promise.all` 로 **동시에** 두드린다
 * (gather.ts). 그래서 느는 것은 합이 아니라 「가장 느린 한 곳」이고, 여기 더해지는
 * 한 곳은 **지금 이 요청을 보낸 그 서버**다(죽어 있을 수 없다). 타임아웃도 그대로
 * 1.5초이고, 그 1.5초는 나머지와 **겹쳐서** 흐른다.
 * 🔵 그리고 이 답은 아래 `siteFeedCache` 에 **함께** 담긴다 — 30초에 한 번이다.
 *
 * 🔴 **치르는 값 하나: 가리는 판단이 최대 30초 낡는다.** 캐시 때문이다. 내용이
 * 방금 바뀐 제 줄이 **최대 30초 동안 확인된 것으로 가려질 수 있다.** 🔵 스스로
 * 낫고(30초 뒤 다시 묻는다), 확인 통로가 이미 같은 값을 같은 까닭으로 치르고 있다
 * (api/integration/notification-acknowledgements/route.ts 의 ⚠️ 그 줄).
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

/**
 * 한 번 모아 온 것 한 벌. 🔴 **둘을 한 칸에 담는다.**
 *
 * 나눠 담으면 열쇠가 둘이 되고, 두 칸이 **다른 나이**로 상할 수 있다 — 그러면
 * 「남의 줄은 새것인데 제 줄을 가리는 판단만 30초 낡은」 상태가 생긴다. 한 칸에
 * 담으면 둘이 언제나 같은 순간의 답이다.
 */
type SiteFeedPair = {
  /** 🔴 **남의 시스템 줄.** 이것만 사이트에 내준다. */
  others: PortalNotificationFeed;
  /**
   * 🔴 **부른 사이트 제 줄. 내주지 않는다** — 확인(✓) 열쇠를 가리는 데만 쓴다.
   *
   * 🔵 「못 물어봤다」와 「제 알림이 없다」는 이 값의 `degraded` 로 갈린다.
   * 알림 통로가 없는 시스템(계측기·PO)이 부르면 `gatherNotifications([])` 가
   * **빈 feed · degraded 아님**을 돌려준다 — 가릴 것이 없는 것이 맞는 답이다.
   */
  own: PortalNotificationFeed;
};

const siteFeedCache = createUserCache<SiteFeedPair>({
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
 * 「그만 보겠다」고 한 줄을 빼고, **그 사이트 몫의 지운 열쇠**를 한 칸 얹는다.
 *
 * 🔴 service.ts 의 `withoutDismissed` 와 **같은 판단이고 다른 반환 모양**이다.
 * 베끼는 까닭은 이 파일 맨 위 상수들과 같다 — 저쪽은 `PortalNotificationFeed`
 * 를, 여기는 칸이 하나 더 붙은 `SiteDismissalFeed` 를 돌려줘야 해서 하나로
 * 합칠 수 없다. 거르는 **계산 자체**는 두 벌이 아니다(둘 다 dismissals.ts 의
 * applyDismissals 로 수렴한다 — applySiteDismissals 가 그것을 그대로 쓴다).
 *
 * ── 🔴 캐시 바깥에서, 꺼낸 뒤에 부른다 ─────────────────────────────────────
 * 거른 결과를 캐시하면 「지웠는데 30초 남는다」가 된다. 그리고 `siteFeedCache`
 * 는 열쇠에 `clientId` 가 섞여 있어, 한 사람의 것을 버리려면 **등록된 시스템을
 * 전부 돌아야 한다.** 거르지 않은 것을 캐시해 두면 그 무효화가 아예 필요 없다
 * (설계안 3-2).
 *
 * ── 🔴 지움 목록을 못 읽으면 — 2026-10-20 사용자 결정 ──────────────────────
 * **거르지 않은 feed 를 `degraded: true` + `dismissed: []` 로 돌려준다.** 종을
 * 통째로 끄면 알림이 아예 안 보인다. 지움은 **보기를 미루는 것이지 지워지는
 * 자료가 아니므로**(설계안 5절 ③), 지웠던 줄이 다시 뜨는 쪽이 덜 나쁘다. 그렇다고
 * 조용히 넘어가면 안 되므로 `degraded` 를 세우고 로그를 한 줄 남긴다 — 「알림이
 * 없다」와 「못 물어봤다」를 나눠 그리는 것이 이 저장소의 규칙이다(merge.ts).
 *
 * 🔵 `dismissed: []` 는 사이트에게 「지운 것이 없다」로 읽힌다. 거짓이지만 **안전한
 * 쪽의 거짓**이다 — 사이트가 제 줄을 하나도 안 빼게 되므로, 못 읽은 지움 때문에
 * 멀쩡한 알림이 사라지는 일은 없다.
 */
async function withoutDismissed(
  params: { userId: string; clientId: string },
  feed: PortalNotificationFeed
): Promise<SiteDismissalFeed> {
  try {
    return applySiteDismissals(feed, await listDismissedKeys(params.userId), params.clientId);
  } catch (error) {
    console.error("[notifications] 지운 알림 목록을 읽지 못했습니다:", error);
    // 🔵 새 객체다. 캐시에 든 feed 를 제자리에서 고치면 그 짝의 다음 요청이
    // 까닭 없이 degraded 로 나간다.
    return { ...feed, degraded: true, dismissed: [] };
  }
}

/**
 * 🔴 **「해소됐다」고 확인한 줄을 뺀다.** service.ts 의 `withoutAcknowledged` 와
 * **같은 판단이고 다른 반환 모양**이다 — 까닭은 이 파일의 다른 베낌들과 같다
 * (저쪽은 `PortalNotificationFeed`, 여기는 칸이 **둘** 더 붙은 `SiteNotificationFeed`).
 * 거르는 **계산 자체**는 두 벌이 아니다 — 둘 다 acknowledgements.ts 로 수렴한다.
 *
 * ── 🔴 일을 **둘** 한다 ───────────────────────────────────────────────────
 *  ① 포털이 모아 온 **남의 시스템 줄**에서 확인된 것을 뺀다(service.ts 와 같다).
 *  ② 🔴 **부른 사이트 제 줄** 가운데 확인된 것의 열쇠를 `acknowledged` 로 얹는다.
 *     그 줄들은 포털이 내주지 않으므로 뺄 수가 없다 — 사이트가 제 손으로 빼라고
 *     열쇠만 넘긴다(own-acknowledgements.ts).
 *
 * 🔵 둘이 **같은 `state` 를 쓴다.** 기록도 분류도 한 번 읽어 양쪽에 그대로 먹인다 —
 * 나눠 읽으면 두 판단이 서로 다른 나이의 DB 를 보게 되고, 관리자가 분류를 바꾸는
 * 바로 그 순간 「남의 줄은 사라졌는데 제 줄은 남는」 답이 나간다.
 *
 * ── 🔴 `dismissed` 칸에는 손대지 않는다 ───────────────────────────────────
 * 그 칸은 **지운(✕) 열쇠**를 사이트에 넘겨 주는 자리다. 확인한 열쇠를 거기 섞으면
 * 사이트가 그것을 지움으로 읽어 **제 목록에서 영구히 빼 버린다** — 뜻이 다른
 * 둘이 한 칸에서 뭉개진다. 🔵 그래서 확인은 **제 칸**으로 간다. 얹는 자리를
 * `withOwnAcknowledgements` 하나로 묶어 둔 까닭도 그것이다.
 */
async function withoutAcknowledged(
  params: { userId: string; clientId: string },
  feed: SiteDismissalFeed,
  own: PortalNotificationFeed
): Promise<SiteNotificationFeed> {
  // 🔴 `own.items` 도 함께 본다. 남의 줄이 하나도 없어도 **제 줄은 가려야 한다** —
  //    이 조각이 메우려는 구멍([재고부족])이 바로 그 경우다.
  if (feed.items.length === 0 && own.items.length === 0) {
    return withOwnAcknowledgements(feed, []);
  }

  try {
    const digests = await listAcknowledgedDigests(params.userId);
    if (digests.size === 0) return withOwnAcknowledgements(feed, []);

    // 🔴 분류를 읽을 시스템에 **부른 사이트도 넣는다.** 빼면 그 사이트의 종류가
    //    전부 「저장된 행이 없음」이 되어 기본값 `ACTION` 으로 떨어지고, 그러면
    //    `acknowledged` 가 **언제나 비어** 이 조각이 통째로 동작하지 않는다.
    const state = {
      digests,
      purposes: await listKindPurposesByClient(sourceIdsOf([...feed.items, ...own.items])),
    };

    // 🔴 `dismissed` 를 그대로 다시 얹는다. applyAcknowledgements 는 칸 넷짜리
    //    feed 만 돌려주므로, 안 얹으면 그 칸이 **있다 없다 하게** 된다.
    return withOwnAcknowledgements(
      { ...applyAcknowledgements(feed, state), dismissed: feed.dismissed },
      ownAcknowledgedKeys({ ownItems: own.items, state, clientId: params.clientId })
    );
  } catch (error) {
    console.error("[notifications] 확인한 알림 목록을 읽지 못했습니다:", error);
    // 🔵 지움과 같은 판단이다 — 거르지 않은 것을 degraded 로 돌려준다. 확인해 둔
    //    줄이 다시 뜨는 쪽이 종이 통째로 꺼지는 것보다 낫다.
    // 🔴 `acknowledged` 도 **빈 배열**이다. 기록을 못 읽었으니 「뺄 것이 없다」가
    //    아니라 「모른다」인데, 모를 때 빼면 **아직 안 한 일이 안 보인다.**
    return withOwnAcknowledgements({ ...feed, degraded: true }, []);
  }
}

/**
 * 🔴 **거르기 한 벌 — 지움 다음에 확인이다.** 돌아가는 길 둘(캐시 적중·새로
 * 모음)에서 같은 한 줄을 부르려고 묶었다. 한 곳에서만 확인을 빠뜨리면 증상이
 * 「확인하면 한 번 사라졌다가 30초 동안 도로 뜬다」가 된다.
 *
 * ── 🔴 부른 사이트에게 못 물어봤으면 `degraded` 다 ─────────────────────────
 * 그때 `acknowledged` 는 비어 나가고(위 withoutAcknowledged 와 같은 저울), 그
 * 결과는 **확인해 둔 제 줄이 그 사이트 종에 다시 뜨는 것**이다. 조용히 넘어가면
 * 증상이 「확인했는데 재고관리에서만 다시 뜬다」 하나뿐이라 원인을 가리키지
 * 않는다 — 「알림이 없다」와 「못 물어봤다」를 나눠 그리는 것이 이 저장소의
 * 규칙이다(merge.ts). 🔵 못 물어본 곳은 `sources` 에 없다. 부른 사이트는 애초에
 * 거기 담기지 않기 때문이다 — `sources` 가 전부 `ok` 인데 `degraded` 가 참이면
 * 그것은 **이 경우**다.
 */
async function visibleTo(
  params: { userId: string; clientId: string },
  pair: SiteFeedPair
): Promise<SiteNotificationFeed> {
  const feed = await withoutAcknowledged(
    params,
    await withoutDismissed(params, pair.others),
    pair.own
  );
  // 🔵 새 객체다. 캐시에 든 것을 제자리에서 고치지 않는다(dismissals.ts 의 그 주석).
  return pair.own.degraded ? { ...feed, degraded: true } : feed;
}

/**
 * 사이트에 내줄 「이 사람의 지금 알림」. **그 사람이 지운(✕) 줄과 확인한(✓) 줄은
 * 빠져 있고, 그 사이트 몫의 지운 열쇠가 `dismissed` 로, 확인한 열쇠가
 * `acknowledged` 로 함께 간다.**
 *
 * 🔴 **칸 둘은 섞이지 않는다.** `dismissed` 에는 지운 열쇠만, `acknowledged` 에는
 * 확인한 열쇠만 담긴다. 수명이 정반대라서다 — 지움은 로그아웃하면 돌아오고 확인은
 * 안 돌아온다(위 withoutAcknowledged 의 그 문단, own-acknowledgements.ts 머리말).
 *
 * 🔴 **던지지 않는다.** 이 값을 기다리는 것은 남의 사이트의 layout 이다 —
 * 여기서 터지면 그 사이트의 화면이 통째로 안 뜬다(설계서 F-8 의 그 줄이
 * 한 칸 더 밖으로 나온 자리다).
 *
 * ── 🔴 늘어난 칸이 어디서 붙는가 ───────────────────────────────────────────
 * **여기다.** 응답 규격(docs/사이트-알림-통로.md)에 칸이 느는 것이 이 반환 타입
 * 하나로 정해진다 — 라우트는 이 값을 그대로 직렬화하고(route.ts 의 마지막 줄),
 * site-feed.ts 의 `feedFor` 는 반환 타입이 `PortalNotificationFeed` 라도 칸이 더
 * 붙은 객체를 그대로 통과시킨다. 🔴 **그래서 site-feed.ts 는 거의 고치지 않았다**
 * — 보안 판정(문 여섯)이 든 파일이라 열 이유가 없다. `feedFor` 곁의 주석 한 줄만
 * 고쳤다(「묻지 않는다」가 더 이상 참이 아니라서다 — 맨 위 ⚠️ 문단).
 *
 * ── 🔴 돌아가는 길이 셋이고, 거를 곳은 둘이다 ─────────────────────────────
 *  ① 캐시 적중  — 🔴 **여기도 거른다.** 빠뜨리기 가장 쉬운 자리이고, 빠뜨리면
 *     증상이 「지우면 한 번 사라졌다가 30초 동안 도로 뜬다」가 된다.
 *  ② 새로 모음  — 거르지 않은 것을 캐시에 넣은 **뒤에** 거른다.
 *  ③ 모으기 실패 — 빈 목록이라 거를 것이 없다. 🔵 그래도 `dismissed`·
 *     `acknowledged` 두 칸은 있어야 한다. 칸이 **있다 없다 하면** 사이트가 그
 *     갈래를 따로 들어야 한다. 🔴 둘 다 **빈 배열**이다 — 여기서는 지운 것도
 *     확인한 것도 **모르는** 상태인데, 모를 때 빼면 아직 안 한 일이 안 보인다.
 */
export async function getSiteNotificationFeed(params: {
  userId: string;
  /**
   * 🔴 부른 사이트. **이 시스템의 알림은 내주지 않는다.**
   * (🔵 확인 열쇠를 가리려고 묻기는 한다 — 맨 위 ⚠️ 문단.)
   */
  exceptClientId: string;
}): Promise<SiteNotificationFeed> {
  const key = siteFeedCacheKey(params.exceptClientId, params.userId);
  const dismissalParams = { userId: params.userId, clientId: params.exceptClientId };

  const cached = siteFeedCache.get(key, Date.now());
  if (cached) return visibleTo(dismissalParams, cached); // ①

  let pair: SiteFeedPair;
  try {
    const { sources, skipped } = toNotificationSources(await listAccessibleClients(params.userId));
    for (const row of skipped) {
      console.error(
        `[notifications] ${row.clientId} 의 launcher_url 이 ${row.reason} 이라 물어볼 수 없습니다. npm run client:register 로 등록하세요.`
      );
    }

    const signToken = signerFor(params.userId);
    // 🔴 부른 사이트의 통로. **없을 수 있다** — 알림을 내지 않는 시스템
    //    (계측기·PO)이 부르는 경우다. 그때는 빈 목록으로 묻고, 가릴 것도 없다.
    const ownSource = sources.find((source) => source.clientId === params.exceptClientId);

    // 🔴 **둘을 동시에 묻는다.** 차례로 물으면 기다리는 시간이 합이 되는데,
    //    gather.ts 가 이미 `Promise.all` 로 도는 덕에 여기서도 묶어 두면 「가장
    //    느린 한 곳」만큼이다(맨 위 왕복 문단의 그 실측).
    const [others, own] = await Promise.all([
      gatherNotifications({
        // 🔴 **내줄 목록에서는 부른 사이트를 뺀다.** 맨 위 네 까닭 그대로다.
        sources: sources.filter((source) => source.clientId !== params.exceptClientId),
        signToken,
      }),
      gatherNotifications({
        // 🔴 **받아 온 줄은 내주지 않는다.** 확인(✓) 열쇠를 가리는 데만 쓴다.
        sources: ownSource ? [ownSource] : [],
        signToken,
      }),
    ]);
    pair = { others, own };
  } catch (error) {
    console.error("[notifications] 사이트에 내줄 알림을 모으지 못했습니다:", error);
    return withOwnAcknowledgements({ ...emptyFeed(), degraded: true, dismissed: [] }, []); // ③
  }

  // ② 🔴 캐시에 들어가는 것은 **거르지 않은** 한 벌이다.
  // 🔵 부른 사이트에게 못 물어본 것도 **짧게** 들고 있는다 — 그래야 저쪽이 살아난
  //    5초 뒤에 확인 가리기가 되돌아온다(길게 들면 30초 동안 안 된다).
  siteFeedCache.set(
    key,
    pair,
    Date.now(),
    pair.others.degraded || pair.own.degraded ? DEGRADED_TTL_MS : undefined
  );
  return visibleTo(dismissalParams, pair);
}
