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
import { applyDismissals } from "./dismissals";
import {
  gatherNotificationSettings,
  gatherNotifications,
  pushNotificationSettings,
  type SignServiceToken,
} from "./gather";
import { emptyFeed, type PortalNotificationFeed } from "./merge";
import {
  emptySettings,
  type PortalSettingsChange,
  type PortalSettingsOverview,
  type PortalSettingsSaveResult,
} from "./settings";
import { toNotificationSources, type NotificationSource } from "./sources";

/**
 * ============================================================================
 * 통합 알림 창구 — 포털 안에서 부르는 입구는 여기 셋뿐이다
 * ============================================================================
 * 이 파일만 바깥 세 가지(DB · 서명 키 · 환경)를 만진다. 판정과 계산은 옆
 * 파일들(sources · merge · settings · gather · cache)에 순수 함수로 있고 각각
 * 시험을 갖는다.
 *
 * 🔴 **알림을 저장하지 않는다.** 설계서 D-2 가 버린 길이다. 여기 있는 캐시는
 * 수십 초 뒤 사라지는 사본이고, 종을 닫으면 포털에 남는 것이 없다.
 *
 * 🔴 **각 시스템의 DB 에 붙지 않는다.** 포털은 그 DB 들을 모른다. 묻는 길은
 * 서명 토큰을 실은 HTTP 하나뿐이다.
 *
 * 🔴 **역할을 판정하지 않는다.** 누가 무엇을 볼 수 있는지는 각 시스템이 자기
 * 역할로 걸러 낸다(설계서 F-4). 포털이 정하는 것은 「어느 시스템에 물을
 * 것인가」 하나뿐이고, 그 판정은 앱 런처와 같은 것을 쓴다.
 * ============================================================================
 */

/**
 * 캐시 수명 30초.
 *
 * 종은 자주 열리고, A/S 는 한 번 물을 때마다 여러 조회를 돈다(설계서 E절).
 * 그렇다고 길게 두면 「처리했는데 알림이 안 사라진다」가 된다 — A/S 가 공짜로
 * 얻고 있는 성질을 포털이 캐시로 깨는 셈이다. 30초는 A/S 종의 1분 폴링 절반이라
 * 사람이 느끼는 지연이 거의 없는 자리다.
 *
 * ── 🔴 이 수명이 `/apps` 타일의 빨간 점에도 그대로 걸린다 ──────────────────
 * 🔴 **개선요청을 다 확인해도 포털 타일의 점은 최대 30초 더 남는다. 고장이
 * 아니다.** 까닭은 이 상수 하나다 — 저쪽에서 0건이 된 뒤에도 포털은 방금 받아
 * 둔 답을 이 시간 동안 기억하고, 그동안 `/apps` 를 새로고침해도 다시 묻지
 * 않는다. 30초가 지나면 저절로 사라진다(merge.ts 의 shouldShowTileDot 곁에도
 * 같은 말을 적어 두었다 — 점이 왜 늦게 사라지는지를 캐시에서 찾는 사람도,
 * 점 규칙에서 찾는 사람도 있어서다).
 *
 * 🔴 **2026-09-23, 이 지연을 그대로 두기로 했다(사용자 결정: 「30초로 하자」).**
 * 까닭 둘:
 *  1. 통합 로그인 화면은 자주 보는 곳이 아니다. 확인하고 나서 30초 안에 다시
 *     그 화면을 볼 일이 드물다.
 *  2. 없애려면 묶임이 하나 는다 — 아래 참조.
 *
 * ── 없애려면 무엇이 필요한가(다시 꺼낼 사람이 처음부터 재지 않도록) ────────
 * 개선요청이 「이 사람이 다 확인했으니 기억해 둔 것을 버려라」를 포털에 알리는
 * **새 통로**가 있어야 한다. 포털 쪽은 작다 — `feedCache.invalidate(userId)` 가
 * 이미 있고(saveNotificationSettings 가 쓴다), 서명 토큰을 받는 라우트 하나를
 * 더 내면 된다. 🔴 **비싼 쪽은 저쪽이다**: 지금 개선요청은 포털이 자기를
 * 부르는 것만 받으면 되는데, 이 통로가 생기면 **개선요청이 포털 주소를 알아야
 * 한다.** 화살표가 한 방향에서 양방향이 되고, 그것이 시스템마다 하나씩 는다.
 * 점 하나가 30초 늦게 사라지는 것과 견줘 그 값이 비싸다고 보았다.
 */
const FEED_TTL_MS = 30_000;

/**
 * 한 곳이라도 못 물어봤을 때의 수명 5초.
 *
 * 30초로 들고 있으면 저쪽이 살아난 뒤에도 한참 빈 채로 보이고, 아예 안 들고
 * 있으면 죽어 있는 동안 종을 여는 사람마다 타임아웃을 기다린다(= 모두에게
 * 느려진다). 5초는 그 사이다.
 */
const DEGRADED_TTL_MS = 5_000;

/**
 * 기억할 사람 수. 사내 인원의 몇 배로 넉넉히 두되 상한은 둔다.
 * 자리가 없으면 캐시를 건너뛸 뿐 답은 그대로 나온다(cache.ts).
 */
const MAX_CACHED_USERS = 500;

const feedCache = createUserCache<PortalNotificationFeed>({
  ttlMs: FEED_TTL_MS,
  maxUsers: MAX_CACHED_USERS,
});

/**
 * 이 사람의 이름으로 서명하는 함수.
 *
 * 🔴 subject 를 **여기서 한 번 닫아 둔다.** 아래로 내려가는 함수들은 「누구」를
 * 다시 정할 수 없다 — 한 요청을 처리하는 도중에 사람이 섞이는 실수를 타입
 * 수준에서 막는다.
 */
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
 * 이 사람에게 물어볼 곳.
 *
 * 🔴 판정은 listAccessibleClients 하나다 — 앱 런처 타일·서비스 메뉴바와 같다.
 * 들어갈 수 없는 시스템에 물으면 그 시스템에 「이 사람이 존재한다」를 알리는
 * 꼴이 된다(backchannel-logout.ts 의 findTargets 와 같은 근거).
 */
async function sourcesFor(userId: string): Promise<NotificationSource[]> {
  const { sources, skipped } = toNotificationSources(await listAccessibleClients(userId));
  for (const row of skipped) {
    // 통로는 등록돼 있는데 주소를 알 수 없는 상태다. 조용히 빠지면 증상이
    // 「알림이 안 온다」 하나뿐이라 원인을 가리키지 않는다.
    console.error(
      `[notifications] ${row.clientId} 의 launcher_url 이 ${row.reason} 이라 물어볼 수 없습니다. npm run client:register 로 등록하세요.`
    );
  }
  return sources;
}

/**
 * 「그만 보겠다」고 한 줄을 뺀다. 🔴 **캐시 바깥에서, 꺼낸 뒤에 부른다.**
 *
 * ── 🔴 왜 거른 결과를 캐시에 넣지 않는가 ───────────────────────────────────
 * 넣으면 **「지웠는데 30초 남는다」**가 된다. ✕ 를 누른 사람에게는 그 30초가
 * 「안 눌렸나」로 보여 다시 누르게 되고, 그래도 그대로다. 거르지 않은 것을
 * 캐시해 두면 ✕ 를 누른 **다음 화면부터 바로** 사라진다 — 지움 목록은 매 요청
 * DB 에서 새로 읽기 때문이다(사람 한 명치, 색인 하나라 싸다). 🔵 그래서 캐시
 * 무효화가 **아예 필요 없다**(설계안 3-2).
 *
 * ── 🔴 지움 목록을 못 읽으면 — 2026-10-20 사용자 결정 ──────────────────────
 * **거르지 않은 feed 를 degraded 로 돌려준다.** 종을 통째로 끄는 길도 있지만
 * 그러면 알림이 아예 안 보인다. 지움은 **보기를 미루는 것이지 지워지는 자료가
 * 아니므로**(설계안 5절 ③), 지웠던 줄이 다시 뜨는 쪽이 덜 나쁘다.
 *
 * 🔴 그렇다고 **조용히 넘어가지는 않는다.** `degraded` 를 세워 화면이 「뭔가
 * 잘못됐다」를 그릴 수 있게 한다 — 「알림이 없다」와 「못 물어봤다」를 나눠
 * 그리는 것이 이 저장소의 규칙이다(merge.ts 의 degraded 주석). 그리고 로그에
 * 한 줄 남긴다. 안 남기면 증상이 「지웠는데 다시 뜬다」 하나뿐이라 DB 를
 * 의심할 단서가 없다(queries/notification-dismissals.ts 의 그 주석).
 *
 * 🔵 `{ ...feed, degraded: true }` 는 **새 객체**다. 캐시에 든 feed 를 제자리에서
 * 고치면 그 사람의 다음 요청이 까닭 없이 degraded 로 나간다.
 */
async function withoutDismissed(
  userId: string,
  feed: PortalNotificationFeed
): Promise<PortalNotificationFeed> {
  try {
    return applyDismissals(feed, await listDismissedKeys(userId));
  } catch (error) {
    console.error("[notifications] 지운 알림 목록을 읽지 못했습니다:", error);
    return { ...feed, degraded: true };
  }
}

/**
 * 🔴 **「해소됐다」고 확인한 줄을 뺀다 — ✕ 지움과 다른 일이다.**
 *
 * 지움은 「지금은 그만 보겠다」라 로그아웃하면 돌아오고, 확인은 돌아오지 않는다.
 * 그래서 표도 다르고(db/schema/notification-acknowledgements.ts) 거르는 조건도
 * 다르다 — 확인은 **셋이 모두** 맞아야 거른다(기록이 있고 · 내용이 그때와 같고 ·
 * 분류가 `INFO` 다). 판단 전부는 acknowledgements.ts 에 순수 함수로 있다.
 *
 * 🔴 **지움 거르기 바로 옆, 캐시 바깥이다.** 위 withoutDismissed 와 같은 자리에
 * 같은 모양으로 둔다 — 한쪽만 캐시 안으로 들어가면 두 거르기가 서로 다른 나이의
 * 목록을 본다. 그리고 분류를 캐시에 넣지 않는 까닭은 저쪽(queries/
 * notification-kind-purposes.ts)에 적었다: 관리자가 분류를 바꾸면 **즉시** 먹어야
 * 한다.
 *
 * ── 왕복을 아끼는 두 줄 ───────────────────────────────────────────────────
 * 🔵 줄이 하나도 없으면 아무것도 묻지 않는다. 🔵 확인 기록이 한 줄도 없으면
 * **분류도 묻지 않는다** — 거를 것이 없는데 분류를 읽어 봐야 쓸 데가 없다.
 * 사내 대부분의 사람이 이 두 갈래로 빠지므로 평소 왕복은 하나다.
 *
 * ── 🔴 못 읽으면 — 지움과 같은 판단이다 ───────────────────────────────────
 * **거르지 않은 feed 를 `degraded: true` 로 돌려준다.** 종을 통째로 끄면 알림이
 * 아예 안 보인다. 확인해 둔 줄이 다시 뜨는 쪽이 덜 나쁘다 — 눈에 거슬릴 뿐 일을
 * 놓치지 않는다. 🔴 그렇다고 조용히 넘어가지 않는다. 안 남기면 증상이 「확인했는데
 * 다시 뜬다」 하나뿐이라 DB 를 의심할 단서가 없다.
 */
async function withoutAcknowledged(
  userId: string,
  feed: PortalNotificationFeed
): Promise<PortalNotificationFeed> {
  if (feed.items.length === 0) return feed;

  try {
    const digests = await listAcknowledgedDigests(userId);
    if (digests.size === 0) return feed;

    const purposes = await listKindPurposesByClient(sourceIdsOf(feed.items));
    return applyAcknowledgements(feed, { digests, purposes });
  } catch (error) {
    console.error("[notifications] 확인한 알림 목록을 읽지 못했습니다:", error);
    // 🔵 새 객체다. 캐시에 든 feed 를 제자리에서 고치면 그 사람의 다음 요청이
    // 까닭 없이 degraded 로 나간다(위 withoutDismissed 와 같은 까닭).
    return { ...feed, degraded: true };
  }
}

/**
 * 🔴 **거르기 한 벌 — 지움 다음에 확인이다.**
 *
 * 돌아가는 길마다 따로 적지 않고 여기 묶는 까닭: 거를 곳이 둘(캐시 적중·새로
 * 모음)이고, **한 곳에서만 확인을 빠뜨리면** 증상이 「확인하면 한 번 사라졌다가
 * 30초 동안 도로 뜬다」가 된다. 묶어 두면 빠뜨릴 자리가 없다.
 *
 * 🔵 차례는 둘 중 아무것이나 되지만 지움을 먼저 둔다 — 지움으로 이미 빠진 줄은
 * 확인 쪽이 들여다볼 까닭이 없고, 그만큼 지문 계산이 준다.
 */
async function visibleTo(
  userId: string,
  feed: PortalNotificationFeed
): Promise<PortalNotificationFeed> {
  return withoutAcknowledged(userId, await withoutDismissed(userId, feed));
}

/**
 * 「이 사람의 지금 알림」 — 통합 종이 그릴 전부. **그 사람이 지운(✕) 줄과
 * 확인한(✓) 줄은 빠져 있다.** 둘은 다른 일이다 — 지움은 로그아웃하면 돌아오고
 * 확인은 안 돌아온다(위 withoutAcknowledged).
 *
 * 🔴 **던지지 않는다.** 종이 통째로 안 뜨는 것이 가장 나쁘다(설계서 F-8).
 * DB 조회까지 실패하면 빈 목록에 degraded 만 세워 돌려준다 — 「알림이 없다」와
 * 「못 물어봤다」는 종이 다르게 그려야 하는 두 가지다.
 *
 * ── 🔴 돌아가는 길이 셋이고, 거를 곳은 둘이다 ─────────────────────────────
 *  ① 캐시 적중  — 🔴 **여기도 거른다.** 빠뜨리기 가장 쉬운 자리이고, 빠뜨리면
 *     증상이 「지우면 한 번 사라졌다가 30초 동안 도로 뜬다」가 된다.
 *  ② 새로 모음  — 거르지 않은 것을 캐시에 넣은 **뒤에** 거른다(위 주석).
 *  ③ 모으기 실패 — 빈 목록이라 거를 것이 없다. 그대로 둔다.
 *
 * 🔵 ①·② 둘 다 `visibleTo` 한 줄이다 — 지움과 확인을 따로 적으면 한쪽 길에서만
 * 한쪽 거르기를 빠뜨릴 수 있다.
 *
 * ── 🔴 알림을 다 지우면 `/apps` 타일의 빨간 점도 사라진다 — 의도한 동작이다 ──
 * **2026-10-20 사용자 결정.** 앱 런처(`src/app/apps/page.tsx`)가 같은 이 함수를
 * 부르고, `shouldShowTileDot` 이 `sources[].count` 를 보는데 그 숫자를 여기서
 * 함께 줄이기 때문이다(dismissals.ts 의 applyDismissals). 「그만 보겠다」고 한
 * 사람에게 점만 남겨 둘 이유가 없다.
 *
 * 🔴 이 줄을 적어 두는 까닭은 **점이 사라진 것을 보고 버그로 신고하기 때문**이다.
 * 고칠 곳이 아니다. 점만 살리고 싶어지면 거기서 거르지 않은 feed 를 따로 받아야
 * 하는데, 그러면 「지웠는데 점은 남는다」라는 더 이상한 상태가 된다.
 */
export async function getNotificationFeed(userId: string): Promise<PortalNotificationFeed> {
  const cached = feedCache.get(userId, Date.now());
  if (cached) return visibleTo(userId, cached); // ①

  let feed: PortalNotificationFeed;
  try {
    feed = await gatherNotifications({
      sources: await sourcesFor(userId),
      signToken: signerFor(userId),
    });
  } catch (error) {
    console.error("[notifications] 알림을 모으지 못했습니다:", error);
    return { ...emptyFeed(), degraded: true }; // ③
  }

  // ② 🔴 캐시에 들어가는 것은 **거르지 않은** feed 다.
  feedCache.set(userId, feed, Date.now(), feed.degraded ? DEGRADED_TTL_MS : undefined);
  return visibleTo(userId, feed);
}

/**
 * 각 시스템의 알림 설정.
 *
 * **캐시하지 않는다.** 여는 사람이 관리자뿐이고 자주 열지 않는데다, 저장 직후
 * 옛 값이 보이는 편이 훨씬 나쁘다 — 켠 것이 꺼진 채로 보이면 사람이 다시
 * 누른다.
 *
 * 🔴 관리자가 아닌 사람에게는 시스템마다 `forbidden` 이 담겨 온다. 정상이다.
 */
export async function getNotificationSettings(userId: string): Promise<PortalSettingsOverview> {
  try {
    return await gatherNotificationSettings({
      sources: await sourcesFor(userId),
      signToken: signerFor(userId),
    });
  } catch (error) {
    console.error("[notifications] 알림 설정을 모으지 못했습니다:", error);
    return { ...emptySettings(), degraded: true };
  }
}

/**
 * 바꾼 설정을 그 시스템으로 되돌려 보낸다.
 *
 * 🔴 **들어갈 수 있는 시스템에만 보낸다.** 읽을 때와 같은 판정이다 — 여기만
 * 느슨하면 아무 client_id 나 적어 보내는 것으로 남의 시스템에 포털 서명이 붙은
 * 쓰기 요청을 만들어 낼 수 있다. (그 시스템도 관리자 여부를 다시 보지만,
 * 겹치는 것이 맞다.)
 */
export async function saveNotificationSettings(params: {
  userId: string;
  clientId: string;
  changes: PortalSettingsChange[];
}): Promise<PortalSettingsSaveResult> {
  let source: NotificationSource | undefined;
  try {
    source = (await sourcesFor(params.userId)).find(
      (candidate) => candidate.clientId === params.clientId
    );
  } catch (error) {
    console.error("[notifications] 저장할 시스템을 찾지 못했습니다:", error);
    return { status: "unavailable", message: "지금은 저장할 수 없습니다." };
  }

  if (!source) {
    return {
      status: "forbidden",
      message: "이 시스템의 알림 설정을 바꿀 수 없습니다.",
    };
  }

  const result = await pushNotificationSettings({
    source,
    changes: params.changes,
    signToken: signerFor(params.userId),
  });

  // 설정이 바뀌면 그 사람에게 보이는 알림도 바뀐다. 30초 동안 옛 목록을
  // 들고 있으면 「껐는데 그대로 있다」가 된다.
  if (result.status === "ok") feedCache.invalidate(params.userId);

  return result;
}
