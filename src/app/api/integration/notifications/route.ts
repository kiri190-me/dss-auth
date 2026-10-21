import { NextResponse } from "next/server";
import {
  getActiveClient,
  hasClientAccess,
  verifyClientSecret,
  type ClientRecord,
} from "@/lib/db/queries/oidc-clients";
import { getUserById } from "@/lib/db/queries/users";
import { keyForRequest, siteNotificationFailureLimiter } from "@/lib/http/rate-limits";
import { handleSiteFeedRequest } from "@/lib/notifications/site-feed";
import { getSiteNotificationFeed } from "@/lib/notifications/site-service";

/**
 * ============================================================================
 * 각 사이트의 **서버**가 부르는 통로 — 「이 사람의 합쳐진 알림 내놔」
 * ============================================================================
 *   POST {포털}/api/integration/notifications
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   sub=<포털 users.id (ID 토큰의 sub)>
 *
 * 답(200): { items, count, sources, degraded, dismissed, acknowledged }
 *   — 앞 넷은 조각 3 이 포털 자신에게 내주는 모양 그대로다(merge.ts 의
 *     PortalNotificationFeed = `@dss/ui` 의 NotificationBell 이 받는 모양).
 *   — 🔴 `dismissed: string[]` 는 **그 사람이 지운(✕) 알림의 열쇠**인데 **부른
 *     사이트 몫만** 담긴다(남의 시스템에서 지운 것은 안 간다 — 까닭은
 *     notifications/dismissals.ts 의 applySiteDismissals). 그 사이트가 제 손으로
 *     그리는 **제 알림 목록에서 이 열쇠들을 빼야 한다.** 남의 줄은 포털이 이미
 *     `items`·`count` 에서 빼고 보낸다.
 *   — 🔴 `acknowledged: string[]` 는 **그 사람이 확인(✓)한 알림의 열쇠**이고,
 *     역시 **부른 사이트 몫만** 담긴다. 쓰는 법은 `dismissed` 와 같다(제 목록에서
 *     뺀다). 🔴 **둘을 한 뭉치로 만들지 마라 — 수명이 정반대다.** 지움은
 *     로그아웃하면 돌아오고 확인은 안 돌아온다. 담기는 조건도 다르다: 확인은
 *     **지문이 지금 내용과 같고 분류가 `INFO` 일 때만** 담긴다(포털이 판정한다 —
 *     notifications/own-acknowledgements.ts). 그래서 「N종 더」처럼 id 가 고정인
 *     줄도 내용이 바뀌면 이 목록에서 빠져 다시 보인다.
 *   🔵 **모르는 칸은 무시되므로 아직 안 고친 사이트도 그대로 돈다.**
 *
 * 🔴 **부른 사이트 자신의 알림은 `items` 에 없다.** 까닭은 site-service.ts 맨
 * 위에 길게 적었다. 사이트는 제 알림을 제 손으로 이어 붙인다.
 * 붙이는 법은 docs/사이트-알림-통로.md.
 *
 * ── 왜 GET 이 아니라 POST 인가 ─────────────────────────────────────────────
 * 읽기지만 **보낼 것이 있고 그중 하나가 비밀값**이다. GET 으로 두면 `sub` 가
 * 주소에 실리고, 주소는 접근 로그·프록시 로그·에러 보고에 그대로 남는다.
 * RFC 7662(토큰 introspection)가 같은 자리에서 같은 선택을 했다 — 자격증명은
 * Basic 머리말, 물어볼 것은 form 본문, 답은 JSON, 전부 no-store.
 *
 * ── 왜 세션이 아니라 client_secret 인가 ────────────────────────────────────
 * 부르는 것이 **브라우저가 아니라 저쪽 서버**다. 포털 세션 쿠키는 포털
 * 도메인으로 오는 브라우저에만 있다. 각 사이트는 이미 client_id 와
 * client_secret 을 갖고 있고(포털이 등록할 때 발급했다), 포털은 그 해시를
 * 갖고 있다. 새 비밀을 하나 더 만들면 돌려 쓸 물건이 하나 더 느는 것뿐이다.
 *
 * ── 🔴 이 통로가 지키는 두 줄 ──────────────────────────────────────────────
 * 사이트는 `sub` 에 아무나 적어 보낼 수 있다(사칭). 그 까닭과 받아들이는
 * 이유는 site-feed.ts 맨 위에 있고, **유일한 방어선**은 거기 ⑤·⑥이다:
 * 정지·삭제된 계정은 거절, 그 시스템에 들어갈 수 없는 사람도 거절.
 *
 * ── 되돌기 ─────────────────────────────────────────────────────────────────
 * ⚠️ **2026-10-22 에 바뀐 줄이다.** 전에는 「포털은 부른 사이트에게 되묻지
 * 않는다」였다. 지금은 **한 번 되묻는다** — 받아 온 줄은 `items` 에 넣지 않고
 * 위 `acknowledged` 를 가리는 데만 쓴다(②·③ 조건은 그 줄 자체가 있어야 본다).
 *
 * 🔴 **그래도 고리는 생기지 않는다.** 각 사이트가 내주는
 * `{사이트}/api/integration/notifications`(GET · 포털 서명 Bearer)는 **제 DB 만**
 * 읽고 포털을 되부르지 않는다 — 넷을 열어 확인했고, 그렇지 않았다면 포털 제 종이
 * 오늘도 이미 무한히 돌고 있었을 것이다(site-service.ts 맨 위의 그 문단).
 * 깊이는 1 이고 늘어난 왕복도 하나이며, 그 하나는 나머지와 **동시에** 흐른다.
 * ============================================================================
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

export async function POST(request: Request) {
  let result;
  try {
    result = await handleSiteFeedRequest<ClientRecord>(request, {
      // 🔴 판정에 쓰는 함수는 전부 **포털에 이미 있는 것**이다. 새로 만들면
      // 앱 런처·인가 엔드포인트와 두 벌이 되고, 두 벌은 언젠가 어긋난다.
      findActiveClient: getActiveClient,
      verifySecret: verifyClientSecret,
      findUser: getUserById,
      hasAccess: hasClientAccess,
      feedFor: getSiteNotificationFeed,
      countAuthFailure: () =>
        siteNotificationFailureLimiter.check(keyForRequest(request), Date.now()),
    });
  } catch (error) {
    // DB 가 죽은 것 같은 경우다. 🔴 이 답을 기다리는 것은 **남의 사이트의
    // layout** 이므로, 500 대신 503 으로 「지금은 안 된다」를 분명히 말한다.
    console.error("[notifications] 사이트 알림 통로가 답하지 못했습니다:", error);
    return NextResponse.json(
      { error: "temporarily_unavailable", error_description: "지금은 알림을 내줄 수 없습니다." },
      { status: 503, headers: NO_STORE }
    );
  }

  if (result.logReason) {
    // 🔴 거절은 **반드시 한 줄 남긴다.** 안 남기면 증상이 「어느 사이트에서만
    // 알림이 안 온다」 하나뿐이고, 그것으로는 시크릿인지 권한인지 알 수 없다.
    // 남기는 것은 까닭 하나뿐이다 — 사람의 id 도, 비밀값도 적지 않는다.
    console.warn(`[notifications] 사이트 알림 요청 거절 ${result.status} (${result.logReason})`);
  }

  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
