import "server-only";
import { getIssuer } from "@/lib/config/env";
import { getSigningKey } from "@/lib/crypto/keys";
import { listAccessibleClients } from "@/lib/db/queries/clients";
import { listEnabledApprovalMailKinds } from "@/lib/db/queries/approval-mail-kinds";
import { listSentApprovalKeys } from "@/lib/db/queries/approval-mail-deliveries";
import { listApprovalMailRecipients } from "@/lib/db/queries/approval-mail-recipients";
import { recordApprovalMailDeliveries } from "@/lib/db/mutations/approval-mail-deliveries";
import { sendPlainMail } from "@/lib/mail/send";
import { signPortalServiceToken } from "@/lib/oidc/service-token";
import { gatherApprovals, type SignApprovalToken } from "./gather";
import { readApprovalInboxUrl } from "./inbox-url";
import {
  runApprovalMailJob,
  type ApprovalMailRunDeps,
  type ApprovalMailRunReport,
} from "./run";
import { toApprovalSources } from "./sources";

/**
 * ============================================================================
 * 결재 알림 메일 작업의 **배선** — 바깥 셋(DB · 서명 키 · 메일)을 만지는 유일한 곳
 * ============================================================================
 * 흐름과 판단은 approvals/run.ts 에 있고, 여기는 그 인자들에 진짜 구현을 끼운다.
 * notifications/service.ts 가 통합 종에 대해 하는 일과 같은 자리다.
 *
 * 🔴 **종의 창구를 부르지 않는다.** 저쪽에는 사람별 캐시(30초)와 지움 · 확인
 * 거르기가 붙어 있는데, 그것들은 전부 **화면에 보이는 종**을 위한 장치다. 결재
 * 메일이 그 캐시를 공유하면, 밤에 도는 작업이 낮에 사람이 보는 종의 캐시를
 * 갈아 치운다. 서명 함수 여덟 줄을 여기 한 번 더 적는 값이 그보다 싸다.
 *
 * 🔴 **지움(✕)과 확인(✓)을 보지 않는다.** 그 둘은 「종에서 그만 보겠다」는 뜻이고,
 * 결재가 끝났다는 뜻이 아니다. 종에서 치운 결재의 메일까지 멎으면 그 결재는
 * 아무 표시 없이 묻힌다 — 세 시스템이 결재 통로에서 알림 설정을 보지 않는 것과
 * 같은 판단이다(A/S portal-approvals.ts 머리말).
 * ============================================================================
 */

/**
 * 이 사람의 이름으로 서명하는 함수.
 *
 * 🔴 subject 를 **여기서 한 번 닫는다.** 아래로 내려가는 함수들은 「누구」를 다시
 * 정할 수 없다 — 한 번 도는 동안 사람이 섞이는 실수를 타입 수준에서 막는다
 * (notifications/service.ts 의 `signerFor` 와 같은 모양).
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
 * 작업에 끼울 진짜 구현들.
 *
 * 🔵 따로 내보내는 까닭: 점검 스크립트가 **일부만 갈아 끼워** 돌릴 수 있게 하기
 * 위해서다(예: `sendMail` 만 가짜로 바꿔 「누구에게 몇 건이 갈 뻔했나」 보기).
 */
export function approvalMailJobDeps(options?: { dryRun?: boolean }): ApprovalMailRunDeps {
  return {
    listRecipients: listApprovalMailRecipients,
    enabledKinds: listEnabledApprovalMailKinds,
    sentKeysFor: listSentApprovalKeys,
    recordDeliveries: recordApprovalMailDeliveries,
    inboxUrl: readApprovalInboxUrl(),
    dryRun: options?.dryRun === true,

    gatherFor: async (recipient) => {
      // 🔴 「이 사람이 들어갈 수 있는 시스템」만 묻는다 — 앱 런처 타일 · 서비스
      //    메뉴바 · 통합 종과 **같은 판정 하나**다(queries/clients.ts).
      const { sources, skipped } = toApprovalSources(
        await listAccessibleClients(recipient.userId)
      );
      for (const row of skipped) {
        // 통로는 있는데 주소를 알 수 없다. 조용히 빠지면 증상이 「메일이 안 온다」
        // 하나뿐이라 원인을 가리키지 않는다.
        console.error(
          `[approvals-mail] ${row.clientId} 의 launcher_url 이 ${row.reason} 이라 물어볼 수 없습니다. npm run client:register 로 등록하세요.`
        );
      }
      return gatherApprovals({ sources, signToken: signerFor(recipient.userId) });
    },

    sendMail: async ({ to, subject, text }) => {
      const result = await sendPlainMail({ to, subject, text });
      if (result.ok) return { ok: true };
      return {
        ok: false,
        message: result.message,
        // 🔴 설정이 없는 것은 사람마다 되풀이해 봐야 소용없는 실패다. 이 표시를
        //    보고 작업이 그 자리에서 멈춘다(approvals/run.ts).
        configMissing: result.reason === "NOT_CONFIGURED",
      };
    },
  };
}

/** 작업 한 번. 작업 스크립트(scripts/send-approval-mails.ts)가 부른다. */
export async function runApprovalMails(options?: {
  dryRun?: boolean;
}): Promise<ApprovalMailRunReport> {
  return runApprovalMailJob(approvalMailJobDeps(options));
}
