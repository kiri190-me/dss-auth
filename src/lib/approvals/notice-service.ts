import "server-only";
import { claimApprovalMailDeliveries } from "@/lib/db/mutations/approval-mail-claims";
import { recordApprovalMailDeliveries } from "@/lib/db/mutations/approval-mail-deliveries";
import { listSentApprovalKeys } from "@/lib/db/queries/approval-mail-deliveries";
import { listEnabledApprovalMailKinds } from "@/lib/db/queries/approval-mail-kinds";
import { getApprovalMailRecipient } from "@/lib/db/queries/approval-mail-recipients";
import {
  describeApprovalNotice,
  runApprovalNoticeForUser,
  type ApprovalNoticeDeps,
} from "./notice-run";
import { approvalMailJobDeps } from "./service";

/**
 * ============================================================================
 * 즉시 결재 알림의 **배선** — 바깥 셋(DB · 서명 키 · 메일)을 만지는 자리
 * ============================================================================
 * 흐름과 판단은 approvals/notice-run.ts 에 있고, 여기는 그 인자들에 진짜 구현을
 * 끼운다. approvals/service.ts 가 주기 작업에 대해 하는 일과 같은 자리다.
 *
 * ── 🔴 묻는 길과 보내는 길은 주기 작업에서 **빌려 온다** ──────────────────
 * `gatherFor` 와 `sendMail` 을 여기 다시 적지 않고 `approvalMailJobDeps()` 가 지은
 * 것을 그대로 쓴다. 베껴 두면 한쪽만 고치는 날 둘이 갈라지는데, 갈라진 것이
 * 「권한대로 걸러진 시스템 목록」이면 **즉시 알림만 남의 시스템에 묻게 되고도
 * 아무 증상이 없다.** 🔵 그 함수가 애초에 「일부만 갈아 끼울 수 있게」 따로
 * 내보내져 있었다(저쪽 주석) — 여기가 그 첫 쓰임이다.
 *
 * ── 🔴 다른 것 하나: **적는 차례** ────────────────────────────────────────
 * 주기 작업은 보내고 나서 적는다. 즉시 알림은 **찍고 나서 보낸다**(`claim` →
 * `sendMail` → `settle`). 그래서 `recordDeliveries` 자리에 들어가는 함수가 둘로
 * 갈린다:
 *
 *   claim  = `claimApprovalMailDeliveries`   — 「내가 보낸다」를 먼저 찍는다
 *   settle = `recordApprovalMailDeliveries`  — 🔵 **주기 작업과 같은 함수다**
 *
 * 거두는 쪽이 같은 함수인 것이 중요하다 — 두 길이 **같은 표에 같은 모양**으로
 * 남아야 「이미 보냈나」를 한 조회로 물을 수 있다(queries/approval-mail-deliveries.ts).
 *
 * 🔴 **종의 창구도, `seen_at` 도 건드리지 않는다.** 주기 작업과 같은 까닭이고
 * (service.ts 머리말), 그 성질은 시험이 구조로 못 박는다
 * (approvals/mail-seen-fence.test.ts 의 「쓰는 곳은 한 자리뿐」).
 * ============================================================================
 */

/**
 * 즉시 알림에 끼울 진짜 구현들.
 *
 * 🔵 따로 내보내는 까닭은 주기 작업 쪽과 같다 — 점검 스크립트가 `sendMail` 만
 * 가짜로 바꿔 「누구에게 몇 건이 갈 뻔했나」를 볼 수 있어야 한다.
 */
export function approvalNoticeDeps(): ApprovalNoticeDeps {
  // 🔴 묻는 길·보내는 길·승인함 주소는 **주기 작업의 것 그대로**다(머리말).
  const job = approvalMailJobDeps();

  return {
    enabledKinds: listEnabledApprovalMailKinds,
    findRecipient: getApprovalMailRecipient,
    sentKeysFor: listSentApprovalKeys,
    claim: claimApprovalMailDeliveries,
    settle: recordApprovalMailDeliveries,
    gatherFor: job.gatherFor,
    sendMail: job.sendMail,
    inboxUrl: job.inboxUrl,
  };
}

/**
 * 한 사람 몫 결재 메일을 **지금** 돌린다. 🔴 **던지지 않는다** — 이 함수는
 * 응답이 나간 뒤에(`after`) 불리므로 던져도 받아 줄 사람이 없다.
 *
 * 🔵 결과를 한 줄 찍는다. 즉시 알림은 주기 작업과 달리 **아무도 보고 있지 않은
 * 때** 돌기 때문에, 「찔렸는데 메일이 왜 안 갔나」를 나중에 물을 수 있는 곳이
 * 서버 로그 한 줄뿐이다. 찍히는 것은 건수와 까닭 글자뿐이고 결재의 내용은
 * 들어가지 않는다(describeApprovalNotice).
 */
export async function notifyApprovalCreated(userId: string): Promise<void> {
  const report = await runApprovalNoticeForUser(userId, approvalNoticeDeps());
  console.log(`[approvals-notice] ${describeApprovalNotice(report)}`);
}
