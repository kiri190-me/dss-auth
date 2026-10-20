import { NextResponse } from "next/server";
import { recordDismissals } from "@/lib/db/mutations/notification-dismissals";
import {
  getActiveClient,
  hasClientAccess,
  verifyClientSecret,
  type ClientRecord,
} from "@/lib/db/queries/oidc-clients";
import { getUserById } from "@/lib/db/queries/users";
import { keyForRequest, siteNotificationFailureLimiter } from "@/lib/http/rate-limits";
import { NO_STORE } from "@/lib/notifications/site-feed";
import { handleDismissalRequest } from "@/lib/notifications/site-dismissals";

/**
 * ============================================================================
 * 각 사이트의 **서버**가 부르는 통로 — 「이 사람이 이 알림들을 지웠다」
 * ============================================================================
 *   POST {포털}/api/integration/notification-dismissals
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   sub=<포털 users.id (ID 토큰의 sub)>&keys=<열쇠,열쇠,...>
 *
 * 답(200): { recorded, dropped }
 *
 * 읽기 통로(api/integration/notifications)와 **짝이다.** 왜 POST 인지, 왜 세션이
 * 아니라 client_secret 인지, 사칭을 왜 받아들이는지는 전부 저쪽과 같은 까닭이고
 * 저쪽 라우트와 site-feed.ts 맨 위에 적혀 있다. 판정은 site-dismissals.ts 에
 * 있고 여기는 그것을 진짜 함수로 채우는 껍데기다.
 * ============================================================================
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let result;
  try {
    result = await handleDismissalRequest<ClientRecord>(request, {
      // 🔴 판정에 쓰는 함수는 전부 **포털에 이미 있는 것**이고, 읽기 통로가 쓰는
      // 것과 **같은 넷**이다. 하나라도 다른 것을 끼우면 「알림은 오는데 지움은
      // 안 먹히는」 사람이 생기고, 그 어긋남은 신고로만 드러난다.
      findActiveClient: getActiveClient,
      verifySecret: verifyClientSecret,
      findUser: getUserById,
      hasAccess: hasClientAccess,
      record: ({ userId, keys }) => recordDismissals(userId, keys),
      // 🔴 **읽기 통로와 같은 통을 쓴다.** 두 통로가 **같은 자격증명**을 받으므로,
      // 통을 나누면 시크릿을 두드리는 쪽이 분당 20번을 **두 번** 얻는다(합쳐서
      // 40번). 같이 쓰면 합쳐서 20번이라 더 좁다. 새로 만들 까닭이 없다.
      countAuthFailure: () =>
        siteNotificationFailureLimiter.check(keyForRequest(request), Date.now()),
    });
  } catch (error) {
    // DB 가 죽은 것 같은 경우다. 🔴 500 대신 503 으로 「지금은 안 된다」를 분명히
    // 말한다 — 읽기 통로와 같다. 🔵 그리고 이 통로는 **몇 번을 다시 보내도
    // 안전하므로**(site-dismissals.ts) 사이트가 503 을 받고 재시도해도 된다.
    console.error("[notifications] 알림 지움을 적지 못했습니다:", error);
    return NextResponse.json(
      { error: "temporarily_unavailable", error_description: "지금은 지움을 적을 수 없습니다." },
      { status: 503, headers: NO_STORE }
    );
  }

  if (result.logReason) {
    // 🔴 거절은 **반드시 한 줄 남긴다.** 안 남기면 증상이 「어느 사이트에서만
    // 지움이 안 먹힌다」 하나뿐이고, 그것으로는 시크릿인지 권한인지 열쇠 모양인지
    // 알 수 없다. 남기는 것은 까닭 하나뿐이다 — 사람의 id 도, 비밀값도, 열쇠도
    // 적지 않는다(열쇠에는 수리 건 번호 같은 업무 식별자가 들어 있다).
    console.warn(`[notifications] 알림 지움 요청 거절 ${result.status} (${result.logReason})`);
  }

  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
