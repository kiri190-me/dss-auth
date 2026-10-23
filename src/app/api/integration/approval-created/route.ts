import { after, NextResponse } from "next/server";
import { handleApprovalCreatedRequest } from "@/lib/approvals/notice-request";
import { notifyApprovalCreated } from "@/lib/approvals/notice-service";
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
 * 각 시스템의 **서버**가 부르는 통로 — 「이 사람에게 결재할 것이 생겼다」
 * ============================================================================
 *   POST {포털}/api/integration/approval-created
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   approverSub=<포털 users.id>&approverSub=<포털 users.id>&…
 *
 * 답(202): { accepted, skipped, dropped }
 *
 * ── 🔴 받는 것은 **사람 번호뿐이다** ──────────────────────────────────────
 * 건 번호도 갈래도 제목도 안 온다. 포털이 **제 통로로 다시 물어** 메일을 만든다.
 * 왜 그렇게까지 하는지는 notice-request.ts 머리말에 있다 — 한 줄로 줄이면
 * 「저쪽이 거짓을 보내도 메일 내용이 안 흔들려야 하기 때문」이다.
 *
 * ── 🔴 왜 202 인가 ───────────────────────────────────────────────────────
 * 이 답은 「메일을 보냈다」가 아니라 「일감을 받았다」다. 실제로 메일이 나가는지는
 * 갈래 설정과 보낸 기록이 정하고, 그 판단은 **응답 뒤에** 돈다. 200 으로 답하면
 * 붙이는 쪽이 언젠가 그 값으로 사람에게 「메일을 보냈습니다」를 띄운다.
 *
 * ── 🔴 메일은 `after` 가 돌린다 ──────────────────────────────────────────
 * 부르는 자리는 사람이 [신청] 단추를 누르고 서 있는 자리이고, 저쪽은 2초 상한을
 * 걸고 기다린다(A/S 의 portal-inbox.ts). SMTP 한 통은 그보다 오래 걸릴 수 있으므로
 * 응답을 **먼저** 돌려주고 메일 일은 응답 뒤로 넘긴다.
 *
 * 🔵 `after` 는 Node 서버와 Docker 컨테이너에서 쓸 수 있다(next 의 after 문서의
 * 그 표). 운영은 오래 도는 Node 하나라 맞는다. 🔴 그냥 Promise 를 띄워 두는
 * 것과 다르다 — 그쪽은 응답이 끝나는 순간 일이 잘릴 수 있다.
 *
 * ── 🔴 못 받아도 결재는 이미 저장돼 있다 ──────────────────────────────────
 * 부르는 쪽은 결재를 저장한 **뒤** 트랜잭션 밖에서 찌른다. 그래서 어떤 거절이
 * 가도 사람에게는 아무 일이 없어야 하고, 못 나간 메일은 **주기 작업**
 * (`npm run notify:approvals`)이 그대로 줍는다. 🔴 그 작업을 없애면 즉시 알림이
 * 한 번 실패할 때마다 그 결재의 메일이 **영영 안 나가고 아무도 신고하지 않는다.**
 *
 * 판정은 approvals/notice-request.ts 에 있고 여기는 그것을 진짜 함수로 채우는
 * 껍데기다 — 이 방향의 통로 넷과 같은 모양이다.
 * ============================================================================
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let result;
  try {
    result = await handleApprovalCreatedRequest<ClientRecord>(request, {
      // 🔴 판정에 쓰는 함수는 전부 **포털에 이미 있는 것**이고, 이 방향의 통로
      // 넷이 쓰는 것과 **같은 넷**이다. 하나라도 다른 것을 끼우면 「승인함에는
      // 뜨는데 메일만 안 오는」 사람이 생기고, 그 어긋남은 신고로만 드러난다.
      findActiveClient: getActiveClient,
      verifySecret: verifyClientSecret,
      findUser: getUserById,
      hasAccess: hasClientAccess,
      notify: ({ userId }) => notifyApprovalCreated(userId),
      // 🔴 **여기가 「빨리 답하고 뒤에서 일한다」의 전부다.** 판정 모듈은
      // `after` 를 모르고(시험이 돌 수 없는 물건이다), 라우트만 끼운다.
      schedule: (task) => after(task),
      // 🔴 **알림 통로들과 같은 통을 쓴다.** 이 방향의 통로가 **같은 자격증명**을
      // 받으므로, 통을 나누면 시크릿을 두드리는 쪽이 분당 20번을 통로 수만큼
      // 얻는다. 같이 쓰면 합쳐서 20번이라 더 좁다.
      countAuthFailure: () =>
        siteNotificationFailureLimiter.check(keyForRequest(request), Date.now()),
    });
  } catch (error) {
    // DB 가 죽은 것 같은 경우다. 🔴 500 대신 503 으로 「지금은 안 된다」를 분명히
    // 말한다 — 이 방향의 통로 넷과 같다. 🔵 그리고 이 통로는 **몇 번을 다시
    // 보내도 안전하므로**(보낸 기록이 겹침을 막는다) 저쪽이 재시도해도 된다.
    console.error("[approvals-notice] 결재 생성 알림을 받지 못했습니다:", error);
    return NextResponse.json(
      {
        error: "temporarily_unavailable",
        error_description: "지금은 결재 생성 알림을 받을 수 없습니다.",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  if (result.logReason) {
    // 🔴 거절은 **반드시 한 줄 남긴다.** 안 남기면 증상이 「결재를 올려도 메일이
    // 안 온다」 하나뿐이고, 그것으로는 시크릿인지 본문 모양인지 알 수 없다.
    // 남기는 것은 까닭 하나뿐이다 — 사람 번호도 비밀값도 적지 않는다.
    console.warn(`[approvals-notice] 결재 생성 알림 거절 ${result.status} (${result.logReason})`);
  }

  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
