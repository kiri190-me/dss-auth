import { NextResponse } from "next/server";
import { handleApprovalInboxRequest } from "@/lib/approvals/screen-request";
import { getScreenApprovalInbox } from "@/lib/approvals/screen-service";
import {
  getActiveClient,
  hasClientAccess,
  verifyClientSecret,
  type ClientRecord,
} from "@/lib/db/queries/oidc-clients";
import { getUserById } from "@/lib/db/queries/users";
import { keyForRequest, siteNotificationFailureLimiter } from "@/lib/http/rate-limits";
import { NO_STORE } from "@/lib/notifications/site-feed";

/**
 * ============================================================================
 * 통합 승인함의 **서버**가 부르는 통로 — 「이 사람이 결재할 건 내놔」
 * ============================================================================
 *   POST {포털}/api/integration/approvals
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   sub=<포털 users.id (ID 토큰의 sub)>
 *
 * 답(200): { items, count, sources, degraded }
 *   — `items[]` 는 열 칸이다. 일곱은 그 시스템이 보낸 것 그대로이고
 *     (`id`·`kind`·`kindLabel`·`subject`·`detail`·`requestedAt`·`href`),
 *     🔴 **셋은 포털이 붙인다**: `key`(`{client_id}:{id}`) · `sourceId` ·
 *     `sourceName`(`clients` 표의 이름). 셋 중 하나라도 빠지면 승인함이 그 줄을
 *     버리고 「N건을 그리지 못했습니다」를 띄운다.
 *   — `sources[]` 는 물어본 결과다. 🔴 **`unavailable` 과 `failed` 가 다르다** —
 *     앞은 물어봤는데 저쪽이 답할 수 없다고 한 것(휴가의 `employee_not_linked`),
 *     뒤는 못 물어본 것이다. `degraded` 는 **`failed` 가 있을 때만** 참이다.
 *
 * ── 🔴 왜 알림 통로를 넓히지 않고 통로를 하나 더 내는가 ──────────────────
 * 종은 시스템마다 알갱이가 다르다 — 재고는 「결재할 불출 신청 3건」처럼 뭉쳐
 * 보내고, 휴가는 링크가 목록으로만 간다. 승인함은 **한 줄 = 한 결재 = 한
 * [승인하기]** 여야 하므로 세 시스템이 전용 통로를 따로 냈고(A/S
 * portal-approvals.ts 머리말), 포털도 그 모양 그대로 나른다.
 *
 * ── 왜 GET 이 아니라 POST 인가 · 왜 세션이 아니라 client_secret 인가 ──────
 * 알림 통로와 **같은 까닭**이고 저쪽 라우트와 notifications/site-feed.ts 맨 위에
 * 적혀 있다. 요약하면: `sub` 를 주소에 실으면 사람 번호가 접근 로그·프록시
 * 로그에 그대로 남고, 부르는 것이 브라우저가 아니라 저쪽 **서버**라 포털 세션
 * 쿠키가 없다.
 *
 * ── 🔴 답은 어디에도 남지 않는다 ─────────────────────────────────────────
 * 종(30초 캐시)과 다르다. 방금 결재한 건이 승인함에 남아 있으면 그 사람이 다시
 * 누르고 「이미 처리된 건」을 본다. 포털에도 캐시가 없고(screen-service.ts),
 * 응답에는 `no-store` 가 붙는다.
 *
 * 판정은 screen-request.ts 에 있고 여기는 그것을 진짜 함수로 채우는 껍데기다.
 * ============================================================================
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let result;
  try {
    result = await handleApprovalInboxRequest<ClientRecord>(request, {
      // 🔴 판정에 쓰는 함수는 전부 **포털에 이미 있는 것**이고, 알림 통로 둘이
      // 쓰는 것과 **같은 넷**이다. 하나라도 다른 것을 끼우면 「종은 오는데
      // 승인함만 비어 있는」 사람이 생기고, 그 어긋남은 신고로만 드러난다.
      findActiveClient: getActiveClient,
      verifySecret: verifyClientSecret,
      findUser: getUserById,
      hasAccess: hasClientAccess,
      inboxFor: getScreenApprovalInbox,
      // 🔴 **알림 통로와 같은 통을 쓴다.** 세 통로가 **같은 자격증명**을 받으므로
      // 통을 나누면 시크릿을 두드리는 쪽이 분당 20번을 **세 번** 얻는다(합쳐서
      // 60번). 같이 쓰면 합쳐서 20번이라 더 좁다.
      countAuthFailure: () =>
        siteNotificationFailureLimiter.check(keyForRequest(request), Date.now()),
    });
  } catch (error) {
    // DB 가 죽은 것 같은 경우다. 🔴 이 답을 기다리는 것은 **승인함의 화면**이므로
    // 500 대신 503 으로 「지금은 안 된다」를 분명히 말한다 — 알림 통로와 같다.
    // 🔵 승인함은 어떤 거절이든 「못 물어봤다」로 받아 까닭을 글자로 띄운다
    //    (그쪽 fetchPortalApprovals) — 빈 목록으로 보이지 않는다.
    console.error("[approvals] 결재함을 내주지 못했습니다:", error);
    return NextResponse.json(
      {
        error: "temporarily_unavailable",
        error_description: "지금은 결재할 건을 내줄 수 없습니다.",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  if (result.logReason) {
    // 🔴 거절은 **반드시 한 줄 남긴다.** 안 남기면 증상이 「승인함이 계속 비어
    // 있다」 하나뿐이고, 그것으로는 시크릿인지 권한인지 알 수 없다. 남기는 것은
    // 까닭 하나뿐이다 — 사람의 id 도 비밀값도 적지 않는다.
    console.warn(`[approvals] 결재함 요청 거절 ${result.status} (${result.logReason})`);
  }

  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
