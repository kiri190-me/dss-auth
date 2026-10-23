import "server-only";
import { getIssuer } from "@/lib/config/env";
import { getSigningKey } from "@/lib/crypto/keys";
import { readApprovalInboxSeenAt } from "@/lib/db/queries/approval-inbox-views";
import { listAccessibleClients } from "@/lib/db/queries/clients";
import { signPortalServiceToken } from "@/lib/oidc/service-token";
import type { SignApprovalToken } from "./gather";
import {
  gatherScreenApprovals,
  type ScreenApprovalInbox,
  type UnreachableApprovalSource,
} from "./screen-gather";
import { toApprovalSources } from "./sources";
import { decideApprovalTileDot } from "./tile-dot";

/**
 * ============================================================================
 * 승인함에 내줄 결재함의 **배선** — 바깥 둘(DB · 서명 키)을 만지는 유일한 곳
 * ============================================================================
 * 흐름과 판단은 screen-gather.ts 에 있고, 여기는 그 인자들에 진짜 구현을 끼운다.
 * notifications/site-service.ts 가 사이트 종에 대해 하는 자리와 같다.
 *
 * 🔴 **종의 창구(getSiteNotificationFeed)를 부르지 않는다.** 저쪽에는 사람별
 * 캐시 30초와 지움(✕)·확인(✓) 거르기가 붙어 있는데, 셋 다 **종**을 위한
 * 장치다. 결재함이 그것을 쓰면 방금 결재한 건이 최대 30초 남고, 종에서 치운
 * 결재가 승인함에서도 사라진다 — ✕ 는 「종에서 그만 보겠다」지 「결재가
 * 끝났다」가 아니다(메일 쪽 service.ts 가 같은 판단을 했고, 세 시스템도 결재
 * 통로에서 알림 설정을 보지 않는다).
 *
 * 🔴 **캐시가 하나도 없다.** 사람이 승인함을 열 때마다 셋에 새로 묻는다.
 * 치르는 값은 왕복 한 번(최대 1.5초, 셋이 동시)이고, 얻는 것은 「방금 결재한
 * 건이 목록에서 바로 사라진다」이다.
 * ============================================================================
 */

/**
 * 이 사람의 이름으로 서명하는 함수.
 *
 * 🔴 subject 를 **여기서 한 번 닫는다.** 아래로 내려가는 함수들은 「누구」를
 * 다시 정할 수 없다 — 한 번 도는 동안 사람이 섞이는 실수를 타입 수준에서
 * 막는다(메일 쪽 service.ts · notifications/site-service.ts 의 `signerFor` 와
 * 같은 모양이고, 같은 까닭으로 여덟 줄을 한 번 더 적었다).
 */
function signerFor(subject: string): SignApprovalToken {
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
 * 승인함에 내줄 「이 사람이 지금 결재할 건」 전부.
 *
 * 🔴 **「이 사람이 들어갈 수 있는 시스템」에만 묻는다** — 앱 런처 타일 · 서비스
 * 메뉴바 · 통합 종 · 결재 메일과 **같은 판정 하나**다(queries/clients.ts 의
 * `listAccessibleClients`). 못 들어가는 시스템에 물으면 그 시스템에 「이 사람이
 * 존재한다」를 알리는 꼴이 된다.
 *
 * 🔴 **던질 수 있다** — DB 가 죽은 경우다. 라우트가 503 으로 받는다. 모으는
 * 동안의 실패(죽음 · 느림 · 토큰 거절)는 던지지 않고 `sources` 로 돌아온다.
 */
export async function getScreenApprovalInbox(params: {
  userId: string;
}): Promise<ScreenApprovalInbox> {
  const tiles = await listAccessibleClients(params.userId);
  const { sources, skipped } = toApprovalSources(tiles);

  // 🔴 **이름을 함께 올린다.** 승인함은 `name` 이 빈 줄을 버리므로, 이름 없이
  //    올리면 「무엇을 못 읽었는지」가 화면에 아예 안 뜬다(screen-gather.ts 의
  //    UnreachableApprovalSource). 이름은 방금 읽은 타일에 이미 들어 있다.
  const nameOf = new Map(tiles.map((tile) => [tile.clientId, tile.name]));
  const unreachable: UnreachableApprovalSource[] = skipped.map((row) => ({
    clientId: row.clientId,
    // 타일에서 온 목록이라 이름이 없을 수 없다. 그래도 빈 이름을 올려 줄이
    // 통째로 사라지는 것보다는 client_id 라도 적어 주는 편이 낫다.
    name: nameOf.get(row.clientId) ?? row.clientId,
    reason: row.reason,
  }));

  for (const row of skipped) {
    // 화면에도 뜨지만 로그에도 남긴다 — 고치는 사람은 화면이 아니라 로그를 본다.
    console.error(
      `[approvals] ${row.clientId} 의 launcher_url 이 ${row.reason} 이라 물어볼 수 없습니다. npm run client:register 로 등록하세요.`
    );
  }

  return gatherScreenApprovals({
    sources,
    unreachable,
    signToken: signerFor(params.userId),
  });
}

/**
 * `/apps` 승인함 타일에 **빨간 점을 띄울 것인가.**
 *
 * 🔴 **던지지 않고 늦지도 않는다**(tile-dot.ts 의 decideApprovalTileDot). 첫
 * 화면을 그리는 길 위에 있으므로 그 둘이 이 함수의 전부다.
 *
 * ── 🔴 왜 「개수만 묻는 가벼운 길」을 따로 내지 않았나 ───────────────────
 * 점 하나를 켜자고 결재함을 통째로 모으는 것이 무거워 보이지만, **더 가벼운 길이
 * 실제로는 없다**:
 *
 *  · 세 시스템의 통로는 `{ items, count }` 를 **한 번에** 내준다. 「개수만」을
 *    받으려면 저쪽 라우트를 고쳐야 하는데 🔴 **그건 다른 저장소 셋**이고, 포털이
 *    먼저 바꾸면 통로가 통째로 어긋난다.
 *  · 그리고 `count` 만으로는 이 점을 **잴 수 없다.** 점의 뜻은 「밀린 것이
 *    있는가」가 아니라 「**마지막으로 연 뒤에 새로 온 것**이 있는가」라서,
 *    줄마다의 `requestedAt` 이 반드시 필요하다. 숫자 하나로는 어제 본 건이
 *    그대로 남아 있는 것과 새 건이 온 것을 구별할 수 없다.
 *
 * 🔵 치르는 값은 한 번의 왕복(셋을 동시에, 최대 1.5초)이고, 그나마 타일을 다
 * 그린 뒤 `<Suspense>` 로 흘러 들어온다(apps/page.tsx). 🔴 **승인함 타일이 없는
 * 사람에게는 아예 부르지 않는다** — 그 판정은 화면이 한다.
 *
 * ── 🔴 캐시하지 않는다 ───────────────────────────────────────────────────
 * 종은 사람마다 30초를 들고 있지만(notifications/service.ts) 결재함에는 캐시가
 * 없다(위 getScreenApprovalInbox 의 머리말). 점도 같은 길을 쓰므로 자연히 매번
 * 새로 센다 — 「처리했는데 점이 30초 남는다」가 없다.
 */
export async function hasNewApprovalsForTile(userId: string): Promise<boolean> {
  return decideApprovalTileDot({
    readSeenAt: () => readApprovalInboxSeenAt(userId),
    // 🔴 **승인함이 받는 것과 글자 하나까지 같은 목록**이다. 점이 「있다」고 한
    //    것과 들어가서 보는 것이 어긋날 길이 없다 — 다른 길로 세면 언젠가
    //    갈라지고, 갈라지면 사람이 점을 안 믿는다.
    // 🔵 이 길은 `seen_at` 을 **갱신하지 않는다.** 갱신은 승인함이 부르는 통로
    //    한 곳뿐이다(screen-request.ts).
    readApprovals: () => getScreenApprovalInbox({ userId }),
  });
}
