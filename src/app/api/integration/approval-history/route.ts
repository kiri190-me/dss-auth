import { NextResponse } from "next/server";
import { handleApprovalHistoryRequest } from "@/lib/approvals/history-request";
import { getPortalApprovalHistory } from "@/lib/approvals/history-service";
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
 * 통합 승인함의 **서버**가 부르는 통로 — 「이 사람이 이 기간에 한 결재 내놔」
 * ============================================================================
 *   POST {포털}/api/integration/approval-history
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   sub=<포털 users.id (ID 토큰의 sub)>&from=<ISO8601>&to=<ISO8601>
 *
 * 답(200): { entries, count, sources, degraded }
 *   — `entries[]` 는 열한 칸이다. 여덟은 그 집이 보낸 것 그대로이고
 *     (`id`·`subject`·`approvalName`·`decidedAt`·`decision`·`relation`·
 *     `counterpartName`·`href`), 🔴 **셋은 포털이 붙인다**: `key`(`{client_id}:{id}`) ·
 *     `sourceId` · `sourceName`(`clients` 표의 이름). 각 집은 제 이름을 모른다.
 *   — 🔴 `entries` 는 **세 집을 합쳐 새것부터** 세운 목록이다. 집별로 뭉쳐 있지 않다.
 *   — `sources[]` 는 물어본 결과이고 갈래가 **둘뿐**이다(`ok`·`failed`). 결재함
 *     통로의 `unavailable` 이 여기 없는 것은 **내역 계약에 그 칸이 없기 때문**이다 —
 *     그 집에 계정이 없는 사람도 200 + 빈 `entries` 를 받는다.
 *   — `degraded` 는 **못 물어본 집이 있을 때만** 참이다.
 *
 * ── 🔴 기간을 못 읽으면 400 `invalid_period` 다 ──────────────────────────
 * 세 집이 쓰는 글자 그대로이고, 거르는 규칙(정규식)도 글자까지 같다. 포털이 먼저
 * 거르는 까닭은 history-request.ts 에 적혀 있다 — 그대로 세 집에 던지면 **셋이 한꺼번에
 * 400** 이 되고, 승인함에는 「세 집을 다 못 물었다」만 남아 제 실수를 안 가리킨다.
 *
 * ── 🔴 답은 어디에도 남지 않는다 ─────────────────────────────────────────
 * 기간을 바꿔 다시 물었는데 옛 답이 돌아오면 사람은 「고른 기간이 안 먹는다」를
 * 본다. 포털에도 캐시가 없고(history-service.ts), 응답에는 `no-store` 가 붙는다.
 *
 * ── 🔴 이 부름은 「승인함을 열었다」로 치지 않는다 ────────────────────────
 * 결재함 통로는 이 자리에서 `markSeen` 을 끼운다. 🔴 **여기는 안 끼운다** — 까닭은
 * history-request.ts 의 그 문단에 있다(지난달 내역을 뒤적이는 것만으로 `/apps`
 * 타일의 빨간 점이 꺼지면 아직 안 본 새 결재가 묻힌다).
 *
 * 판정은 history-request.ts 에 있고 여기는 그것을 진짜 함수로 채우는 껍데기다.
 * ============================================================================
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let result;
  try {
    result = await handleApprovalHistoryRequest<ClientRecord>(request, {
      // 🔴 판정에 쓰는 함수는 전부 **포털에 이미 있는 것**이고, 알림·결재함 통로가
      // 쓰는 것과 **같은 넷**이다. 하나라도 다른 것을 끼우면 「결재함은 보이는데
      // 내역만 비는」 사람이 생기고, 그 어긋남은 신고로만 드러난다.
      findActiveClient: getActiveClient,
      verifySecret: verifyClientSecret,
      findUser: getUserById,
      hasAccess: hasClientAccess,
      historyFor: getPortalApprovalHistory,
      // 🔴 **알림·결재함 통로와 같은 통을 쓴다.** 통로들이 **같은 자격증명**을 받으므로
      // 통을 나누면 시크릿을 두드리는 쪽이 통로 수만큼 분당 20번을 더 얻는다.
      countAuthFailure: () =>
        siteNotificationFailureLimiter.check(keyForRequest(request), Date.now()),
    });
  } catch (error) {
    // DB 가 죽은 것 같은 경우다. 🔴 이 답을 기다리는 것은 **승인함의 화면**이므로
    // 500 대신 503 으로 「지금은 안 된다」를 분명히 말한다 — 옆 통로들과 같다.
    console.error("[approval-history] 결재 내역을 내주지 못했습니다:", error);
    return NextResponse.json(
      {
        error: "temporarily_unavailable",
        error_description: "지금은 결재 내역을 내줄 수 없습니다.",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  if (result.logReason) {
    // 🔴 거절은 **반드시 한 줄 남긴다.** 안 남기면 증상이 「내역이 계속 비어 있다」
    // 하나뿐이고, 그것으로는 시크릿인지 권한인지 기간인지 알 수 없다. 남기는 것은
    // 까닭 하나뿐이다 — 사람의 id 도 비밀값도 기간도 적지 않는다.
    console.warn(`[approval-history] 내역 요청 거절 ${result.status} (${result.logReason})`);
  }

  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
