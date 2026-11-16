import { NextResponse } from "next/server";
import { handleDelegationRequest } from "@/lib/approvals/delegation-request";
import {
  createApprovalDelegation,
  revokeApprovalDelegation,
} from "@/lib/db/mutations/approval-delegations";
import {
  listAllApprovalDelegations,
  listApprovalDelegationsForUser,
  listDelegateCandidates,
  resolveActingApproverSubjects,
} from "@/lib/db/queries/approval-delegations";
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
 * 결재권 위임 통로 — 각 시스템이 **묻고**, 통합 승인함이 **쓴다**
 * ============================================================================
 *   POST {포털}/api/integration/delegations
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   sub=<포털 users.id (ID 토큰의 sub)>&action=<acting|list|candidates|create|revoke>&…
 *
 * 일 다섯:
 *   · `acting` — 각 시스템의 **서버**가 결재할 때 묻는다. 답은 `{ subs, count }`
 *     이고 🔴 **`subs[0]` 은 언제나 부른 사람 자신**이다
 *   · `list`   — 승인함이 묻는다. `scope=mine`(기본) 또는 `scope=all`(포털 관리자)
 *   · `candidates` — 승인함의 **고르개**가 묻는다. 대리인으로 세울 수 있는 사람의
 *     `sub`·이름까지만 돌려준다. 🔴 **이메일은 포털 관리자가 물었을 때만** 실리고,
 *     실었는지를 답이 **스스로 말한다**(`emailsIncluded`) — 그 칸이 없으면 받는 쪽이
 *     「가려진 null」과 「원래 없는 null」을 가를 수 없다
 *   · `create` — 승인함이 지정한다
 *   · `revoke` — 승인함이 되돌린다
 *
 * 설계는 dss-approvals/DELEGATION_DESIGN.md 에 있고, 이 라우트는 그 **조각 1** 이다.
 * 판정은 전부 lib/approvals/delegation-request.ts 에 있고 여기는 그것을 진짜 함수로
 * 채우는 껍데기다.
 *
 * ── 🔴 왜 읽기까지 전부 POST 인가 ────────────────────────────────────────
 * `sub` 를 주소에 실으면 **사람 번호가 접근 로그·프록시 로그에 그대로 남는다.**
 * 결재함 통로(api/integration/approvals)와 **같은 까닭**이고, 길이 둘이면 둘 다
 * 지켜야 한다. 🔵 부르는 것이 브라우저가 아니라 저쪽 **서버**라 포털 세션 쿠키도
 * 없다 — 자격은 `client_secret` 하나다.
 *
 * ── 🔴 못 물었을 때는 「위임 없음」이다 (2026-11-16 결정) ─────────────────
 * 각 시스템은 이 통로에 **3초** 상한을 걸고 묻는다. 넘거나 깨지면 **위임이 없는
 * 것으로 보고 결재를 그대로 진행한다 — 거절하지 않는다.** 본인 번호는 언제나 목록
 * 맨 앞에 있으므로 **본인의 결재는 멀쩡히 돌아가고 대리인만 막힌다.**
 *
 * 🔴 **그래서 부르는 쪽이 눈에 보이는 안내를 띄우기로 했다.** 「조용히 막힌다」가 이
 * 시스템들에서 가장 비싼 결함 모양이다 — 대리인은 자기가 왜 못 누르는지 알 길이 없고,
 * 맡긴 사람은 맡겨 뒀다고 믿는다. 🔵 그 안내는 **이 통로의 일이 아니다**(조각 3·4).
 * 여기서 할 수 있는 것은 **안 된다는 말을 분명히 하는 것**뿐이라, 깨진 때는 빈 답이
 * 아니라 503 을 돌려준다.
 * ============================================================================
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let result;
  try {
    result = await handleDelegationRequest<ClientRecord>(request, {
      // 🔴 판정에 쓰는 함수 넷은 전부 **포털에 이미 있는 것**이고, 앞의 다섯 통로가
      // 쓰는 것과 **같은 넷**이다. 하나라도 다른 것을 끼우면 「종은 오는데 위임만 안
      // 먹히는」 사람이 생기고, 그 어긋남은 신고로만 드러난다.
      findActiveClient: getActiveClient,
      verifySecret: verifyClientSecret,
      findUser: getUserById,
      hasAccess: hasClientAccess,
      actingFor: ({ userId, now }) => resolveActingApproverSubjects(userId, now),
      listForUser: ({ userId }) => listApprovalDelegationsForUser(userId),
      // 🔴 **인가를 여기서 보지 않는다.** 「모두의 위임」은 조회 자신이 깃발을 묻고
      // 거절한다(queries/approval-delegations.ts) — 라우트가 가리는 데 그치면 이
      // 조회를 부르는 새 자리가 생기는 날 조용히 다 새어 나간다.
      listAll: ({ actorUserId, now }) => listAllApprovalDelegations(actorUserId, now),
      // 🔴 **여기도 인가를 보지 않는다 — 다만 까닭이 위와 정반대다.** 「모두의 위임」은
      // 조회가 제 손으로 거절하지만, 고르개는 **아무도 거절하지 않는다**(제 결재권을
      // 맡기려면 누구나 골라야 한다). 갈리는 것은 **이메일 한 칸**뿐이고 그 판정은
      // 판정 층의 `candidatesForActor` 가 한다 — 가리는 일은 「누가 물었나」를 아는
      // 쪽의 일이라, 인자도 없는 이 조회에 맡기지 않는다.
      listCandidates: listDelegateCandidates,
      create: createApprovalDelegation,
      revoke: revokeApprovalDelegation,
      // 🔴 **앞의 통로들과 같은 통을 쓴다.** 여섯 통로가 **같은 자격증명**을 받으므로
      // 통을 나누면 시크릿을 두드리는 쪽이 분당 20번을 **한 번 더** 얻는다. 같이
      // 쓰면 합쳐서 20번이라 더 좁다.
      countAuthFailure: () =>
        siteNotificationFailureLimiter.check(keyForRequest(request), Date.now()),
    });
  } catch (error) {
    // DB 가 죽은 것 같은 경우다. 🔴 500 대신 503 으로 「지금은 안 된다」를 분명히
    // 말한다 — 앞의 통로들과 같다. 🔵 저쪽은 이것을 「못 물었다」로 받고 위임 없이
    // 진행한다(머리말). 빈 답을 돌려주면 저쪽은 **물어본 것이 성공했다고 믿는다.**
    console.error("[delegations] 결재권 위임 요청을 처리하지 못했습니다:", error);
    return NextResponse.json(
      {
        error: "temporarily_unavailable",
        error_description: "지금은 결재권 위임을 처리할 수 없습니다.",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  if (result.logReason) {
    // 🔴 거절은 **반드시 한 줄 남긴다.** 안 남기면 증상이 「대리 결재가 안 된다」
    // 하나뿐이고, 그것으로는 시크릿인지 권한인지 기간인지 알 수 없다. 남기는 것은
    // 까닭 하나뿐이다 — 사람의 번호도 비밀값도 사유 글도 적지 않는다.
    console.warn(`[delegations] 결재권 위임 요청 거절 ${result.status} (${result.logReason})`);
  }

  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
