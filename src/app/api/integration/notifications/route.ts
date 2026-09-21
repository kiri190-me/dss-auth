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
 * 답(200): { items, count, sources, degraded }
 *   — 조각 3 이 포털 자신에게 내주는 모양 그대로다(merge.ts 의
 *     PortalNotificationFeed = `@dss/ui` 의 NotificationBell 이 받는 모양).
 *
 * 🔴 **부른 사이트 자신의 알림은 빠져 있다.** 까닭은 site-service.ts 맨 위에
 * 길게 적었다. 사이트는 제 알림을 제 손으로 이어 붙인다.
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
 * 🔴 포털은 **부른 사이트에게 되묻지 않는다.** 그래서 이 통로는
 * `사이트 → 포털 → 그 사이트` 고리를 만들 수 없다. 알림 통로를 가진 시스템이
 * 부른 사이트 하나뿐이면 포털은 **아무에게도 묻지 않고** 빈 목록으로 답한다.
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
