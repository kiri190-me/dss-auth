import type { ApprovalDeliveryClaim, ApprovalDeliveryClaimed } from "@/lib/db/mutations/approval-mail-claims";
import type { GatheredApprovals } from "./gather";
import { buildApprovalMailMessage } from "./mail-message";
import { approvalDeliveryKey, selectApprovalsToMail } from "./plan";
import type { ApprovalDeliveryRecord, ApprovalMailRecipient, ApprovalMailSendOutcome } from "./run";

/**
 * ============================================================================
 * **한 사람 몫**을 지금 당장 — 결재가 생긴 그 순간의 메일 (2026-10-24)
 * ============================================================================
 * 세 시스템(A/S · 재고 · 휴가)이 결재를 저장한 **뒤** 포털을 찌르면, 포털이 그
 * 사람 몫만 지금 돌린다. 찔러 온 쪽이 보낸 것은 **사람 번호 하나뿐**이고 결재의
 * 내용은 한 글자도 오지 않는다 — 포털이 **제 통로로 다시 물어** 만든다
 * (approvals/notice-request.ts 머리말).
 *
 * 밤에 도는 작업(approvals/run.ts)과 **같은 재료 · 같은 규칙**을 쓴다:
 *  · 같은 갈래 설정(`enabledKinds`, 기본은 전부 끔)
 *  · 같은 고르기(`selectApprovalsToMail`)
 *  · 같은 본문(`buildApprovalMailMessage` — 내용을 싣지 않는다)
 *  · 같은 기록(`approval_mail_deliveries`)
 *
 * 🔴 **다른 것은 차례 하나뿐이다.**
 *
 *   주기 작업: 보내고 나서 적는다.
 *   즉시 알림: **적고 나서 보낸다.**
 *
 * 까닭은 approvals/delivery-state.ts 머리말에 길게 있다. 요약하면: 주기 작업은
 * 사람과 사람 사이가 순서대로라 「보내고 적기」로도 겹칠 일이 없지만, 즉시
 * 알림은 **같은 사람에 대해 둘이 동시에** 들어올 수 있어서(결재 둘이 1초 사이에
 * 생김) 조회와 쓰기 사이에 틈이 있으면 같은 메일이 두 통 간다. 그래서 먼저
 * 찍는다(`claim`) — 찍힌 것만 내 것이다.
 *
 * 🔴 **적고 나서 보내면 치르는 값**: 보내기가 실패했을 때 그 줄이 「보냈음」으로
 * 남아 영영 안 나갈 수 있다. 그래서 **실패하면 그 자리에서 거둔다**(`settle` 에
 * `FAILED` 로 적는다 → 주기 작업이 다음 번에 집는다). 거두기마저 실패하면
 * `SENDING` 인 채 남는데, 그것도 **수명이 지나면 주기 작업이 줍는다.** 즉
 * 어느 길로 가도 「조용히 영영 안 가는 결재」가 생기지 않는다.
 *
 * ── 🔴 이 파일은 던지지 않는다 ────────────────────────────────────────────
 * 부르는 자리가 **응답을 이미 보낸 뒤**(라우트의 `after`)라 여기서 던지면 받아
 * 줄 사람이 없다 — 잡히지 않은 거절은 Node 프로세스를 죽일 수 있고, 그 프로세스는
 * **일곱 사이트의 로그인을 떠받치는** 포털이다. 그래서 무엇이 깨져도 기록
 * (`error`)에 담아 돌려준다.
 * ============================================================================
 */

export type ApprovalNoticeDeps = {
  /** 켜 둔 갈래의 열쇠(`{client_id}:{kind}`). 🔴 주기 작업과 **같은 조회**다. */
  enabledKinds: () => Promise<ReadonlySet<string>>;
  /** 그 사람. 🔴 **ACTIVE 가 아니면 null** 이어야 한다(주기 작업의 대상과 같은 규칙). */
  findRecipient: (userId: string) => Promise<ApprovalMailRecipient | null>;
  /** 그 사람 몫으로 결재 통로들을 묻는다. 🔴 주기 작업과 **같은 왕복**이다. */
  gatherFor: (recipient: ApprovalMailRecipient) => Promise<GatheredApprovals>;
  /** 그 사람에게 **이미 보낸** 것들(`{client_id}:{item_id}`). */
  sentKeysFor: (userId: string) => Promise<ReadonlySet<string>>;
  /** 🔴 「내가 보낸다」를 먼저 찍는다. **찍힌 것만** 돌아온다. */
  claim: (params: {
    userId: string;
    rows: readonly ApprovalDeliveryClaim[];
  }) => Promise<readonly ApprovalDeliveryClaimed[]>;
  /** 찍어 둔 줄을 `SENT` 또는 `FAILED` 로 **거둔다**. 주기 작업의 적기와 같은 함수다. */
  settle: (params: {
    userId: string;
    rows: readonly ApprovalDeliveryRecord[];
  }) => Promise<void>;
  sendMail: (params: { to: string; subject: string; text: string }) => Promise<ApprovalMailSendOutcome>;
  /** 메일에 적을 승인함 주소. 없으면 주소 줄만 빠진다(mail-message.ts). */
  inboxUrl: string | null;
};

/**
 * 아무것도 안 한 까닭. 🔴 **전부 다른 글자다** — 뭉치면 「메일이 안 와요」라는
 * 신고 하나에 볼 것이 없어진다(approvals/run.ts 머리말의 그 규칙).
 */
export type ApprovalNoticeSkip =
  /** 켜 둔 갈래가 하나도 없다. 기본값이 전부 끔이라 **평범한 상태**다. */
  | "no_enabled_kinds"
  /** 포털에 없거나 ACTIVE 가 아닌 사람. 🔴 라우트가 이미 걸렀어야 한다. */
  | "unknown_user"
  /** 포털 계정에 메일 주소가 없다. */
  | "no_email"
  /** 보낼 것이 없다. 대부분이 여기 든다(이미 보냈거나 꺼 둔 갈래거나). */
  | "nothing_to_send"
  /** 🔴 **다른 요청이 이미 보내고 있다.** 고장이 아니다 — 겹침을 막은 것이다. */
  | "already_claimed"
  /** 보내려다 실패했다. 찍어 둔 줄은 거뒀다(주기 작업이 다시 집는다). */
  | "send_failed"
  /** 메일 설정 자체가 없다. */
  | "mail_config_missing"
  /** 도중에 깨졌다. 자세한 말은 `error` 에 있다. */
  | "error";

export type ApprovalNoticeReport = {
  userId: string;
  /** 메일이 **나갔는가.** */
  mailed: boolean;
  /** 메일에 실린 결재건 수. */
  itemsMailed: number;
  /** 아무것도 안 한 까닭. 메일이 나갔으면 null. */
  skipped: ApprovalNoticeSkip | null;
  /** 보내기가 실패했을 때 메일 서버가 돌려준 말. */
  sendError: string | null;
  /** 🔴 찍어 둔 줄을 **거두지 못했다.** 수명이 지나야 주기 작업이 줍는다. */
  settleFailed: boolean;
  /** 🔴 깨진 자리의 말. 던지는 대신 여기 담는다. */
  error: string | null;
  skippedUnknownKind: number;
  skippedDisabled: number;
  skippedAlreadySent: number;
  skippedDuplicate: number;
  /** 🔴 찍으려다 **다른 요청에 뺏긴** 수. 겹침을 막은 수이고, 고장이 아니다. */
  skippedLostRace: number;
  /** 🔴 저쪽이 답할 수 없다고 한 사정(휴가의 `employee_not_linked`). */
  unavailableSources: { clientId: string; reason: string }[];
  /** 🔴 못 물어본 시스템. 「결재가 없다」와 다른 일이다. */
  failedSources: { clientId: string; reason: string }[];
};

function emptyReport(userId: string): ApprovalNoticeReport {
  return {
    userId,
    mailed: false,
    itemsMailed: 0,
    skipped: null,
    sendError: null,
    settleFailed: false,
    error: null,
    skippedUnknownKind: 0,
    skippedDisabled: 0,
    skippedAlreadySent: 0,
    skippedDuplicate: 0,
    skippedLostRace: 0,
    unavailableSources: [],
    failedSources: [],
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 한 사람에게 지금 메일을 보낸다. 🔴 **던지지 않는다**(머리말).
 *
 * 차례:
 *   ① 켜 둔 갈래가 없으면 **아무 데도 묻지 않는다**(주기 작업과 같은 판단).
 *   ② 그 사람이 ACTIVE 이고 메일 주소가 있는가.
 *   ③ 그 사람이 들어갈 수 있는 시스템들에 결재를 묻는다.
 *   ④ 꺼 둔 갈래 · 모르는 갈래 · **이미 보낸 건**을 뺀다.
 *   ⑤ 🔴 남은 것에 「내가 보낸다」를 **찍는다.** 찍힌 것만 내 것이다.
 *   ⑥ 찍힌 것으로 본문을 만들어 한 통 보낸다.
 *   ⑦ 🔴 찍어 둔 줄을 거둔다 — 성공이면 `SENT`, 실패면 `FAILED`.
 */
export async function runApprovalNoticeForUser(
  userId: string,
  deps: ApprovalNoticeDeps
): Promise<ApprovalNoticeReport> {
  const report = emptyReport(userId);

  try {
    // ① 🔴 켜 둔 갈래가 하나도 없으면 **아무에게도 묻지 않는다.** 기본값이
    //    「전부 끔」이라(2026-10-23) 이것이 평범한 상태다. 여기서 안 끊으면
    //    결재가 생길 때마다 사내 시스템 셋을 아무 소득 없이 두드린다.
    const enabledKeys = await deps.enabledKinds();
    if (enabledKeys.size === 0) {
      report.skipped = "no_enabled_kinds";
      return report;
    }

    // ② 🔴 라우트가 이미 ACTIVE 를 봤지만 **여기서 다시 본다.** 이 일은 응답
    //    뒤에 돌고, 그 사이에 계정이 정지될 수 있다. 그리고 이 함수는 라우트
    //    말고 다른 자리에서도 불릴 수 있어야 한다.
    const recipient = await deps.findRecipient(userId);
    if (recipient === null) {
      report.skipped = "unknown_user";
      return report;
    }
    if (recipient.email === null || recipient.email === "") {
      // 🔴 조용히 빠지면 「왜 나만 메일이 안 오지」로 헤매고, 원인이 포털 계정의
      //    빈 칸 하나라는 것을 아무도 못 찾는다(주기 작업과 같은 규칙).
      report.skipped = "no_email";
      console.warn(
        `[approvals-notice] user ${userId} 의 메일 주소가 없어 보내지 못했습니다.`
      );
      return report;
    }

    // ③ 결재 통로들에 묻는다. 🔴 못 물어본 시스템이 있어도 나머지는 보낸다.
    const gathered = await deps.gatherFor(recipient);
    for (const outcome of gathered.outcomes) {
      if (outcome.status === "unavailable") {
        report.unavailableSources.push({ clientId: outcome.clientId, reason: outcome.reason });
      } else if (outcome.status === "failed") {
        report.failedSources.push({ clientId: outcome.clientId, reason: outcome.reason });
      }
    }

    // ④ 주기 작업과 **같은 고르기**다. 꺼진 갈래는 여기서 빠진다.
    const selection = selectApprovalsToMail({
      items: gathered.items,
      enabledKeys,
      alreadySent: await deps.sentKeysFor(userId),
    });
    report.skippedUnknownKind = selection.skippedUnknownKind;
    report.skippedDisabled = selection.skippedDisabled;
    report.skippedAlreadySent = selection.skippedAlreadySent;
    report.skippedDuplicate = selection.skippedDuplicate;

    if (selection.toSend.length === 0) {
      report.skipped = "nothing_to_send";
      return report;
    }

    /*
      ⑤ 🔴 **여기가 겹침을 막는 자리다.**

      ④ 의 `alreadySent` 조회만으로는 못 막는다 — 조회와 보내기 사이에 다른
      요청이 끼어들 틈이 있다. 그 조회는 **쓸데없는 왕복을 줄이는 거름망**일
      뿐이고, 진짜 문은 이 한 문장이다(mutations/approval-mail-claims.ts).
    */
    const claimed = await deps.claim({
      userId,
      rows: selection.toSend.map((item) => ({
        clientId: item.clientId,
        itemId: item.id,
        kind: item.kind,
      })),
    });

    const claimedKeys = new Set(
      claimed.map((row) => approvalDeliveryKey(row.clientId, row.itemId))
    );
    const mine = selection.toSend.filter((item) =>
      claimedKeys.has(approvalDeliveryKey(item.clientId, item.id))
    );
    report.skippedLostRace = selection.toSend.length - mine.length;

    if (mine.length === 0) {
      // 🔵 고장이 아니다. 같은 사람에 대해 둘이 거의 동시에 들어왔고, 먼저 온
      //    쪽이 전부 가져간 것이다 — 메일은 그쪽이 보낸다.
      report.skipped = "already_claimed";
      return report;
    }

    /*
      ⑥ 🔴 본문은 **찍힌 것(`mine`)만으로** 만든다. `selection.toSend` 로 만들면
      뺏긴 건까지 센 건수가 적히고, 그 숫자는 승인함에서 보이는 수와 다르다.
      🔵 본문에 들어가는 것은 갈래별 건수와 주소뿐이다 — 저쪽 글자가 실릴 길이
      애초에 없다(approvals/inbox.ts 가 `id`·`kind` 만 들여온다).
    */
    const message = buildApprovalMailMessage({ items: mine, inboxUrl: deps.inboxUrl });
    const sent = await deps.sendMail({
      to: recipient.email,
      subject: message.subject,
      text: message.text,
    });

    /*
      ⑦ 🔴 **거두기.** 찍어 둔 줄은 지금 `SENDING` 이고, 그 글자는 수명이 지나기
      전까지 「보냈다」로 읽힌다. 실패했는데 그대로 두면 그 결재의 메일이 수명
      만큼 늦는다 — 바로 `FAILED` 로 바꿔 주기 작업이 **다음 번에** 집게 한다.
    */
    const rows: ApprovalDeliveryRecord[] = mine.map((item) => ({
      clientId: item.clientId,
      itemId: item.id,
      kind: item.kind,
      status: sent.ok ? "SENT" : "FAILED",
      error: sent.ok ? null : sent.message,
    }));

    try {
      await deps.settle({ userId, rows });
    } catch (error) {
      report.settleFailed = true;
      console.error(
        `[approvals-notice] 보낸 기록을 거두지 못했습니다 (user ${userId}). ` +
          "그 줄들은 「보내는 중」으로 남고, 수명이 지난 뒤 주기 작업이 다시 집습니다:",
        error
      );
    }

    if (sent.ok) {
      report.mailed = true;
      report.itemsMailed = mine.length;
    } else {
      report.skipped = sent.configMissing === true ? "mail_config_missing" : "send_failed";
      report.sendError = sent.message;
      console.error(
        `[approvals-notice] user ${userId} 에게 보내지 못했습니다: ${sent.message}`
      );
    }

    return report;
  } catch (error) {
    // 🔴 여기서 던지면 응답이 이미 나간 뒤라 받아 줄 사람이 없다(머리말).
    report.skipped = "error";
    report.error = messageOf(error);
    console.error(`[approvals-notice] user ${userId} 차례가 깨졌습니다:`, error);
    return report;
  }
}

/**
 * 한 번의 즉시 알림을 사람이 읽는 한 줄로. 🔴 **결재의 내용은 들어가지 않는다** —
 * 들어가는 것은 건수와 까닭 글자뿐이다(기록 표와 같은 규칙).
 *
 * 🔵 「보낼 것 없음」도 찍는다. 안 찍으면 「찔렀는데 아무 일도 안 일어났다」와
 * 「애초에 안 찔렸다」가 로그에서 구별되지 않는다.
 */
export function describeApprovalNotice(report: ApprovalNoticeReport): string {
  const parts: string[] = [`user ${report.userId}`];

  if (report.mailed) parts.push(`메일 1통 · 결재 ${report.itemsMailed}건`);
  else parts.push(`메일 없음 (${report.skipped ?? "unknown"})`);

  if (report.skippedLostRace > 0) parts.push(`겹쳐서 넘김 ${report.skippedLostRace}`);
  if (report.skippedAlreadySent > 0) parts.push(`이미 보냄 ${report.skippedAlreadySent}`);
  if (report.skippedDisabled > 0) parts.push(`꺼 둔 갈래 ${report.skippedDisabled}`);
  if (report.skippedUnknownKind > 0) parts.push(`모르는 갈래 ${report.skippedUnknownKind}`);
  if (report.settleFailed) parts.push("🔴 기록을 거두지 못함");
  if (report.sendError !== null) parts.push(`보내기 실패: ${report.sendError}`);
  if (report.error !== null) parts.push(`깨짐: ${report.error}`);
  for (const row of report.failedSources) parts.push(`✗ ${row.clientId}(${row.reason})`);
  for (const row of report.unavailableSources) parts.push(`⚠ ${row.clientId}(${row.reason})`);

  return parts.join(" · ");
}
