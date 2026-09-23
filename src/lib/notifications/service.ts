import "server-only";
import { getIssuer } from "@/lib/config/env";
import { getSigningKey } from "@/lib/crypto/keys";
import { listAccessibleClients } from "@/lib/db/queries/clients";
import { signPortalServiceToken } from "@/lib/oidc/service-token";
import { createUserCache } from "./cache";
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
 * 「이 사람의 지금 알림」 — 통합 종이 그릴 전부.
 *
 * 🔴 **던지지 않는다.** 종이 통째로 안 뜨는 것이 가장 나쁘다(설계서 F-8).
 * DB 조회까지 실패하면 빈 목록에 degraded 만 세워 돌려준다 — 「알림이 없다」와
 * 「못 물어봤다」는 종이 다르게 그려야 하는 두 가지다.
 */
export async function getNotificationFeed(userId: string): Promise<PortalNotificationFeed> {
  const cached = feedCache.get(userId, Date.now());
  if (cached) return cached;

  let feed: PortalNotificationFeed;
  try {
    feed = await gatherNotifications({
      sources: await sourcesFor(userId),
      signToken: signerFor(userId),
    });
  } catch (error) {
    console.error("[notifications] 알림을 모으지 못했습니다:", error);
    return { ...emptyFeed(), degraded: true };
  }

  feedCache.set(userId, feed, Date.now(), feed.degraded ? DEGRADED_TTL_MS : undefined);
  return feed;
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
