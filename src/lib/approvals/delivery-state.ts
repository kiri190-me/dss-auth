import { approvalDeliveryKey } from "./plan";

/**
 * ============================================================================
 * 보낸 기록의 **상태 글자 셋**과 「보내는 중」의 수명 — 순수 계산만
 * ============================================================================
 * `approval_mail_deliveries.status` 에 들어가는 글자는 지금 셋이다.
 *
 *   SENT     보냈다.                      → 다시 안 보낸다.
 *   FAILED   보내려다 실패했다.            → 다음 번에 다시 보낸다.
 *   SENDING  🔴 **지금 보내는 중이다.**    → 아래 수명 동안만 다시 안 보낸다.
 *
 * ── 🔴 `SENDING` 이 왜 생겼는가 ───────────────────────────────────────────
 * 2026-10-24 부터 결재 메일은 **결재가 생긴 그 순간** 나간다 — 세 시스템이 포털을
 * 찌르면 포털이 그 사람 몫만 지금 돌린다(approvals/notice-run.ts). 그러면 같은
 * 사람에 대해 **두 번이 거의 동시에** 들어올 수 있다(결재 둘이 1초 사이에 생김).
 *
 * 밤에 도는 주기 작업은 **보내고 나서 적는다**(approvals/run.ts 의 그 문단).
 * 사람과 사람 사이가 순서대로라 그래도 됐다. 하지만 동시에 둘이 들어오면 그
 * 차례는 깨진다 — 둘 다 「아직 안 보냄」을 읽고 **둘 다 보낸다.** 그래서 즉시
 * 알림은 거꾸로 **적고 나서 보낸다**: 먼저 `SENDING` 으로 자리를 찍고(DB 의 유일
 * 색인이 둘 중 하나만 찍히게 한다), 찍은 것만 메일에 싣는다.
 *
 * ── 🔴 적고 나서 보내면 생기는 구멍, 그리고 그 마개 ───────────────────────
 * 찍어 놓고 **보내기 전에 프로세스가 죽으면** 그 줄은 `SENDING` 인 채로 남고,
 * 그 결재의 메일은 **영영 안 나간다.** 그것이 run.ts 가 「보내고 나서 적기」를
 * 고른 까닭이기도 하다.
 *
 * 🔵 마개는 **수명**이다. `SENDING` 은 아래 시간 동안만 「보냈다」로 치고, 그보다
 * 오래된 `SENDING` 은 다시 「아직 안 보냄」이 된다 — 주기 작업이 그때 줍는다.
 * 치르는 값은 「메일이 5분 늦게 한 번 더 갈 수 있다」이고, 얻는 것은 「조용히
 * 영영 안 가는 결재가 없다」이다. 이 표의 모든 판단이 그 방향이다
 * (db/schema/approval-mail-deliveries.ts: 「놓치는 쪽과 두 번 가는 쪽 중에서」).
 *
 * 🔴 **마이그레이션이 필요 없다.** `status` 에는 CHECK 도 pgEnum 도 걸려 있지
 * 않고(그 파일의 그 주석), 읽는 쪽이 「`SENT` 가 아니면 아직 안 보냄」으로 떨어
 * 지게 지어져 있다. 그래서 글자 하나를 늘리는 데 표를 고칠 일이 없다 — 그 주석이
 * 미리 적어 둔 그대로다.
 * ============================================================================
 */

/** 보냈다. 🔴 이 글자만이 「다시 안 보낸다」의 근거다. */
export const APPROVAL_DELIVERY_SENT = "SENT";
/** 보내려다 실패했다. 다음 번에 다시 보낸다. */
export const APPROVAL_DELIVERY_FAILED = "FAILED";
/** 🔴 지금 보내는 중이다. 수명 안에서만 「보냈다」로 친다. */
export const APPROVAL_DELIVERY_SENDING = "SENDING";

/**
 * 「보내는 중」을 믿어 주는 시간. 5분.
 *
 * 🔴 **메일 한 통이 나가는 데 걸리는 시간보다 넉넉히 길어야 한다.** 짧으면 아직
 * 보내는 중인 건을 주기 작업이 집어 **같은 메일이 두 통** 간다. SMTP 왕복은
 * 길어야 몇 초이고(lib/mail/send.ts), 5분은 그보다 두 자릿수 넉넉하다.
 *
 * 🔴 반대로 너무 길면 프로세스가 죽었을 때 그 결재의 메일이 그만큼 늦는다.
 * 사람이 결재를 처리하는 단위가 시간이라 5분은 눈에 띄지 않는다.
 */
export const APPROVAL_SENDING_LEASE_MS = 5 * 60 * 1000;

/** 기록 한 줄 가운데 「다시 보낼까」를 정하는 데 쓰는 칸만. */
export type ApprovalDeliveryState = {
  clientId: string;
  itemId: string;
  /** 🔴 모르는 글자가 와도 된다 — 아래에서 「아직 안 보냄」으로 떨어진다. */
  status: string;
  /** 보낸(또는 찍은) 때. `SENDING` 의 수명을 여기서 잰다. */
  sentAt: Date;
};

/**
 * 이 줄 때문에 **다시 보내지 않아야** 하는가.
 *
 * 🔴 `SENT` 는 언제까지나 참이다. `SENDING` 은 수명 안에서만 참이고, 그 밖의
 * 글자(`FAILED` · 모르는 글자)는 언제나 거짓이다 — 거짓이 「다시 보낸다」쪽이라
 * 모르는 글자가 들어와도 **놓치지 않는다.**
 *
 * 🔴 **찍기의 SQL 조건이 이 함수의 정확한 반대다**
 * (mutations/approval-mail-claims.ts 의 `setWhere`). 둘은 같은 물음에 답한다 —
 * 하나는 메모리에서, 하나는 Postgres 안에서. 어긋나면 「읽기는 보냈다는데 찍기는
 * 덮는」 틈이 생기고, 그 틈으로 **같은 메일이 두 통** 간다. 경계도 같은 쪽으로
 * 떨어져 있다(딱 수명만큼 지난 순간부터 둘 다 「아직 안 보냄」이다).
 * 🔴 한쪽을 고치려거든 **반드시 둘을 함께** 본다.
 */
export function countsAsSentApproval(
  row: { status: string; sentAt: Date },
  now: Date
): boolean {
  if (row.status === APPROVAL_DELIVERY_SENT) return true;
  if (row.status !== APPROVAL_DELIVERY_SENDING) return false;
  return now.getTime() - row.sentAt.getTime() < APPROVAL_SENDING_LEASE_MS;
}

/**
 * 기록 줄들에서 「이미 보낸 것」의 열쇠 집합을 만든다.
 *
 * 🔴 **사람이 섞이지 않게 하는 책임은 부르는 쪽에 있다** — 열쇠 글자에는 사람이
 * 없다(approvals/plan.ts 의 `approvalDeliveryKey`). 그 사람 몫만 읽어 넘겨야 한다
 * (db/queries/approval-mail-deliveries.ts 의 `where`).
 */
export function sentApprovalKeysFrom(
  rows: readonly ApprovalDeliveryState[],
  now: Date
): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!countsAsSentApproval(row, now)) continue;
    keys.add(approvalDeliveryKey(row.clientId, row.itemId));
  }
  return keys;
}
