import type { GatheredApprovals } from "./gather";
import { selectApprovalsToMail } from "./plan";
import { buildApprovalMailMessage } from "./mail-message";

/**
 * ============================================================================
 * 결재 알림 메일 작업의 **흐름** — DB 도 네트워크도 모른다
 * ============================================================================
 * 사람마다 이 차례로 돈다:
 *
 *   ① 활성 사용자를 고른다 — 🔴 메일 주소가 없는 사람은 건너뛰되 **적어 둔다.**
 *   ② 그 사람 몫 토큰을 구워 세 통로를 **동시에** 부른다(approvals/gather.ts).
 *   ③ 갈래 설정이 **켜진 것**만 남긴다.
 *   ④ **보낸 기록이 없는 것**만 남긴다.
 *   ⑤ 남은 것이 있으면 **메일 한 통**을 보낸다(건마다 한 통이 아니다).
 *   ⑥ 보낸 뒤 기록을 남긴다 — 성공도 실패도.
 *
 * 바깥일은 전부 인자(`deps`)로 받는다. 이 파일의 값어치는 **사람이 빠질 때 ·
 * 시스템이 죽을 때 · 이미 보냈을 때** 제대로 도는가에 있고, 그것을 실제 DB 와
 * 메일 서버로 시험할 수는 없기 때문이다(notifications/gather.ts 가 fetch 와
 * 서명을 인자로 받는 것과 같은 까닭).
 *
 * ── 🔴 조용히 빠지는 것이 없게 ────────────────────────────────────────────
 * 이 작업이 틀어졌을 때 사람이 들고 오는 신고는 언제나 **「메일이 안 와요」**
 * 하나다. 그래서 돌려주는 기록이 **왜 안 갔는지를 갈라서** 담는다 — 메일 주소가
 * 없는 사람 · 저쪽이 답할 수 없는 사정(휴가의 계정 미연결) · 못 물어본 시스템 ·
 * 꺼 둔 갈래 · 이미 보낸 건이 전부 다른 칸이다.
 *
 * ── 🔴 순서: 보내고 나서 적는다 ───────────────────────────────────────────
 * 먼저 적고 보내면, 보내기가 실패했을 때 **보낸 적 없는 건이 「보냈음」으로 남아
 * 영영 안 나간다.** 거꾸로(보내고 적기) 하면 적기가 실패했을 때 **내일 한 번 더
 * 간다.** 놓치는 쪽과 두 번 가는 쪽 중에서 두 번 가는 쪽을 고른다.
 *
 * 🔴 **즉시 알림은 이 차례를 뒤집었다**(approvals/notice-run.ts, 2026-10-24).
 * 여기서 「보내고 적기」가 되는 까닭은 사람과 사람 사이가 **순서대로** 돌아서
 * 같은 사람 차례가 겹칠 일이 없기 때문인데, 즉시 알림은 같은 사람에 대해 둘이
 * **동시에** 들어올 수 있다. 그래서 저쪽은 먼저 찍고 보낸다 — 찍어 놓고 죽은
 * 줄에는 수명을 둬서, 수명이 지나면 **이 작업이 줍는다**(delivery-state.ts).
 *
 * 🔴 **그래서 이 작업을 없애면 안 된다.** 즉시 알림이 한 번 실패하면(포털이
 * 잠깐 죽었거나, 저쪽이 못 찔렀거나) 그 결재의 메일은 영영 안 나가고 **아무도
 * 신고하지 않는다.** 이 작업이 그 뒷받침이다.
 *
 * ── 🔵 사람 단위로 차례차례 돈다 ──────────────────────────────────────────
 * 한 사람 안에서는 세 시스템을 동시에 부르지만, 사람과 사람 사이는 순서대로다.
 * 전부 한꺼번에 던지면 사내 시스템 셋에 (사람 수 × 3) 개의 요청이 동시에 꽂힌다 —
 * 밤에 도는 작업이라 서두를 까닭이 없다.
 * ============================================================================
 */

/** 메일을 받을 수 있는 사람 하나. 🔴 주소가 없는 사람도 담겨 온다(세어야 하므로). */
export type ApprovalMailRecipient = {
  userId: string;
  displayName: string;
  email: string | null;
};

/** 한 통 보내기의 결과. 🔴 던지지 않는다. */
export type ApprovalMailSendOutcome =
  | { ok: true }
  | {
      ok: false;
      message: string;
      /**
       * 🔴 **메일 설정 자체가 없다.** 이 값이 참이면 작업을 **그 자리에서
       * 멈춘다** — 사람 수만큼 같은 실패를 되풀이하고 그만큼의 실패 기록을
       * 쌓아 봐야 얻는 것이 없다.
       */
      configMissing?: boolean;
    };

/** 기록 한 줄. 🔴 결재의 내용은 들어 있지 않다(열쇠와 갈래뿐). */
export type ApprovalDeliveryRecord = {
  clientId: string;
  itemId: string;
  kind: string;
  status: "SENT" | "FAILED";
  error: string | null;
};

export type ApprovalMailRunDeps = {
  /** 🔴 활성 사용자 전부. 메일 주소가 없는 사람도 포함해서 준다. */
  listRecipients: () => Promise<readonly ApprovalMailRecipient[]>;
  /** 켜 둔 갈래의 열쇠(`{client_id}:{kind}`). 비어 있으면 **아무것도 안 한다.** */
  enabledKinds: () => Promise<ReadonlySet<string>>;
  /** 그 사람 몫으로 세 통로를 묻는다. */
  gatherFor: (recipient: ApprovalMailRecipient) => Promise<GatheredApprovals>;
  /** 그 사람에게 **이미 보낸** 것들(`{client_id}:{item_id}`). */
  sentKeysFor: (userId: string) => Promise<ReadonlySet<string>>;
  sendMail: (params: {
    to: string;
    subject: string;
    text: string;
  }) => Promise<ApprovalMailSendOutcome>;
  recordDeliveries: (params: {
    userId: string;
    rows: readonly ApprovalDeliveryRecord[];
  }) => Promise<void>;
  /** 메일에 적을 승인함 주소. 없으면 주소 줄만 빠진다(mail-message.ts). */
  inboxUrl: string | null;
  /** 🔵 참이면 **보내지도 적지도 않고** 셈만 한다. 작업 스크립트의 `--dry-run`. */
  dryRun?: boolean;
};

export type ApprovalMailRunReport = {
  dryRun: boolean;
  /** 켜 둔 갈래 수. 🔴 0 이면 아래 숫자가 전부 0 이고, 그것이 정상이다. */
  enabledKindCount: number;
  /** 활성 사용자 수(메일 주소 없는 사람 포함). */
  recipients: number;
  /** 🔴 메일 주소가 없어 건너뛴 사람. **조용히 빠지지 않는다.** */
  skippedNoEmail: { userId: string; displayName: string }[];
  /** 메일을 보낸 사람 수. */
  mailed: number;
  /** 보낼 것이 없어 **메일을 안 보낸** 사람 수. 대부분이 여기 든다. */
  nothingToSend: number;
  /** 메일에 실린 결재건 수(사람별 합). */
  itemsMailed: number;
  /** 보내려다 실패한 사람. */
  sendFailures: { userId: string; message: string }[];
  /** 🔴 보내기는 했는데 **기록을 못 남긴** 사람. 내일 한 번 더 간다. */
  recordFailures: { userId: string; message: string }[];
  /** 🔴 저쪽이 답할 수 없다고 한 사정(휴가의 `employee_not_linked`). */
  unavailableSources: { userId: string; clientId: string; reason: string }[];
  /** 🔴 못 물어본 시스템. 「결재가 없다」와 다른 일이다. */
  failedSources: { userId: string; clientId: string; reason: string }[];
  /** 포털이 모르는 갈래. 🔴 0 이 아니면 approvals/kinds.ts 에 한 줄 더할 때다. */
  skippedUnknownKind: number;
  skippedDisabled: number;
  skippedAlreadySent: number;
  skippedDuplicate: number;
  /** 그 사람 차례에서 통째로 깨진 경우. 나머지 사람은 계속 돈다. */
  userErrors: { userId: string; message: string }[];
  /** 🔴 메일 설정이 없어 작업을 멈췄는가. */
  stoppedForMailConfig: boolean;
};

function emptyReport(dryRun: boolean): ApprovalMailRunReport {
  return {
    dryRun,
    enabledKindCount: 0,
    recipients: 0,
    skippedNoEmail: [],
    mailed: 0,
    nothingToSend: 0,
    itemsMailed: 0,
    sendFailures: [],
    recordFailures: [],
    unavailableSources: [],
    failedSources: [],
    skippedUnknownKind: 0,
    skippedDisabled: 0,
    skippedAlreadySent: 0,
    skippedDuplicate: 0,
    userErrors: [],
    stoppedForMailConfig: false,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 작업 한 번. 🔴 **던지지 않는다** — 한 사람 때문에 나머지 사람의 메일이 멎으면
 * 안 된다. 깨진 자리는 `userErrors` 에 담겨 돌아온다.
 */
export async function runApprovalMailJob(
  deps: ApprovalMailRunDeps
): Promise<ApprovalMailRunReport> {
  const report = emptyReport(deps.dryRun === true);

  const enabledKeys = await deps.enabledKinds();
  report.enabledKindCount = enabledKeys.size;

  /*
   * 🔴 **켜 둔 갈래가 하나도 없으면 아무에게도 묻지 않는다.**
   *
   * 기본값이 「전부 끔」이라(2026-10-23 결정) 이 작업을 켜 두고 갈래를 하나도
   * 안 켠 상태가 **평범한 상태**다. 그때도 사람마다 세 통로를 두드리면 날마다
   * (사람 수 × 3) 번의 요청이 아무 소득 없이 사내 시스템 셋에 꽂힌다.
   */
  if (enabledKeys.size === 0) {
    console.warn(
      "[approvals-mail] 켜 둔 결재 갈래가 없습니다. 아무에게도 묻지 않고 끝냅니다 — " +
        "「알림 설정」 화면의 「결재 알림 메일」에서 갈래를 켜십시오."
    );
    return report;
  }

  const recipients = await deps.listRecipients();
  report.recipients = recipients.length;

  for (const recipient of recipients) {
    // ① 🔴 메일 주소가 없는 사람. 조용히 빠지면 「왜 나만 메일이 안 오지」로
    //    헤매고, 원인이 포털 계정의 빈 칸 하나라는 것을 아무도 못 찾는다.
    if (recipient.email === null || recipient.email === "") {
      report.skippedNoEmail.push({
        userId: recipient.userId,
        displayName: recipient.displayName,
      });
      continue;
    }

    try {
      // ② 세 통로를 동시에.
      const gathered = await deps.gatherFor(recipient);
      for (const outcome of gathered.outcomes) {
        if (outcome.status === "unavailable") {
          report.unavailableSources.push({
            userId: recipient.userId,
            clientId: outcome.clientId,
            reason: outcome.reason,
          });
        } else if (outcome.status === "failed") {
          report.failedSources.push({
            userId: recipient.userId,
            clientId: outcome.clientId,
            reason: outcome.reason,
          });
        }
      }

      // ③④ 꺼 둔 갈래와 이미 보낸 건을 뺀다.
      const selection = selectApprovalsToMail({
        items: gathered.items,
        enabledKeys,
        alreadySent: await deps.sentKeysFor(recipient.userId),
      });
      report.skippedUnknownKind += selection.skippedUnknownKind;
      report.skippedDisabled += selection.skippedDisabled;
      report.skippedAlreadySent += selection.skippedAlreadySent;
      report.skippedDuplicate += selection.skippedDuplicate;

      // 🔴 보낼 것이 0건이면 **메일을 안 보낸다.** 「오늘은 결재할 게 없습니다」
      //    같은 메일은 날마다 가는 소음이고, 그런 메일이 쌓이면 진짜 알림까지
      //    읽히지 않는다.
      if (selection.toSend.length === 0) {
        report.nothingToSend += 1;
        continue;
      }

      const message = buildApprovalMailMessage({
        items: selection.toSend,
        inboxUrl: deps.inboxUrl,
      });

      if (report.dryRun) {
        // 🔵 보내지도 적지도 않는다. 숫자는 「보냈다면 이랬을 것」으로 센다.
        report.mailed += 1;
        report.itemsMailed += selection.toSend.length;
        continue;
      }

      // ⑤ 한 사람에게 한 통.
      const sent = await deps.sendMail({
        to: recipient.email,
        subject: message.subject,
        text: message.text,
      });

      if (!sent.ok && sent.configMissing === true) {
        // 🔴 설정이 없다. 남은 사람에게도 똑같이 실패할 일이라 여기서 멈춘다.
        report.stoppedForMailConfig = true;
        report.sendFailures.push({ userId: recipient.userId, message: sent.message });
        console.error(
          `[approvals-mail] 메일 설정이 없어 작업을 멈춥니다: ${sent.message}`
        );
        return report;
      }

      // ⑥ 성공도 실패도 적는다. 실패로 적은 줄은 **다음 번에 다시 보낸다.**
      const rows: ApprovalDeliveryRecord[] = selection.toSend.map((item) => ({
        clientId: item.clientId,
        itemId: item.id,
        kind: item.kind,
        status: sent.ok ? "SENT" : "FAILED",
        error: sent.ok ? null : sent.message,
      }));

      try {
        await deps.recordDeliveries({ userId: recipient.userId, rows });
      } catch (error) {
        // 🔴 메일은 이미 나갔다. 기록만 못 남겼으므로 **내일 한 번 더 간다** —
        //    그 사실을 분명히 적어 둔다(이 파일 머리말의 그 선택).
        report.recordFailures.push({
          userId: recipient.userId,
          message: messageOf(error),
        });
        console.error(
          `[approvals-mail] 보낸 기록을 남기지 못했습니다 (user ${recipient.userId}). ` +
            "같은 메일이 한 번 더 갈 수 있습니다:",
          error
        );
      }

      if (sent.ok) {
        report.mailed += 1;
        report.itemsMailed += selection.toSend.length;
      } else {
        report.sendFailures.push({ userId: recipient.userId, message: sent.message });
      }
    } catch (error) {
      // 한 사람 차례가 통째로 깨졌다. 나머지 사람은 계속 돈다.
      report.userErrors.push({ userId: recipient.userId, message: messageOf(error) });
      console.error(`[approvals-mail] user ${recipient.userId} 차례에서 실패했습니다:`, error);
    }
  }

  return report;
}

/**
 * 작업 기록을 사람이 읽는 여러 줄로. 작업 스크립트가 로그에 그대로 찍는다.
 *
 * 🔴 **0 인 줄도 적는다.** 「보낸 것 없음」이 적혀 있어야 「작업이 돌기는 했다」를
 * 나중에 알 수 있다(계측기 알림 작업이 1일이 아닌 날에도 기록을 남기는 것과 같은
 * 까닭 — dss-deploy/nas/jobs/notify-daily.sh).
 */
export function describeApprovalMailRun(report: ApprovalMailRunReport): string[] {
  const lines: string[] = [];
  if (report.dryRun) lines.push("※ 시험 실행(--dry-run) — 메일도 기록도 남기지 않았습니다.");
  lines.push(`켜 둔 갈래 ${report.enabledKindCount}개 · 대상 ${report.recipients}명`);
  lines.push(
    `메일 ${report.mailed}통 · 실린 결재 ${report.itemsMailed}건 · 보낼 것 없음 ${report.nothingToSend}명`
  );
  lines.push(
    `건너뜀 — 꺼 둔 갈래 ${report.skippedDisabled} · 이미 보냄 ${report.skippedAlreadySent} · ` +
      `모르는 갈래 ${report.skippedUnknownKind} · 겹침 ${report.skippedDuplicate}`
  );

  if (report.skippedNoEmail.length > 0) {
    lines.push(`메일 주소가 없어 건너뛴 사람 ${report.skippedNoEmail.length}명:`);
    for (const row of report.skippedNoEmail) {
      lines.push(`  · ${row.displayName} (${row.userId})`);
    }
  }
  for (const row of report.unavailableSources) {
    lines.push(`  ⚠ ${row.clientId} 가 답할 수 없다고 합니다 (${row.reason}) — user ${row.userId}`);
  }
  for (const row of report.failedSources) {
    lines.push(`  ✗ ${row.clientId} 에 묻지 못했습니다 (${row.reason}) — user ${row.userId}`);
  }
  for (const row of report.sendFailures) {
    lines.push(`  ✗ 보내지 못했습니다 — user ${row.userId}: ${row.message}`);
  }
  for (const row of report.recordFailures) {
    lines.push(`  ✗ 기록을 남기지 못했습니다(메일은 나감) — user ${row.userId}: ${row.message}`);
  }
  for (const row of report.userErrors) {
    lines.push(`  ✗ user ${row.userId} 차례가 깨졌습니다: ${row.message}`);
  }
  if (report.stoppedForMailConfig) {
    lines.push("🔴 메일 설정이 없어 작업을 중간에 멈췄습니다.");
  }

  return lines;
}

/**
 * 작업이 「실패」로 끝나야 하는가. 스크립트의 종료 코드가 된다.
 *
 * 🔴 **못 물어본 시스템 하나로는 실패가 아니다.** 그것까지 실패로 치면 시스템
 * 하나를 껐다 켜는 날마다 작업 스케줄러가 빨개지고, 그 빨강이 계속되면 아무도
 * 보지 않게 된다. 🔴 **메일이 안 나간 것**(보내기 실패 · 설정 없음 · 사람 차례가
 * 깨짐 · 기록 실패)만 실패로 센다.
 */
export function approvalMailRunFailed(report: ApprovalMailRunReport): boolean {
  return (
    report.stoppedForMailConfig ||
    report.sendFailures.length > 0 ||
    report.recordFailures.length > 0 ||
    report.userErrors.length > 0
  );
}
