import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvalMailDeliveries } from "@/lib/db/schema";
import type { ApprovalDeliveryRecord } from "@/lib/approvals/run";

/**
 * 보낸(또는 보내려다 실패한) 기록을 적는다.
 *
 * 🔴 **있으면 고친다(upsert).** 지난번에 실패로 남은 줄을 이번에 성공으로 덮어야
 * 하기 때문이다. 넣기만 하면 유일 제약(`approval_mail_deliveries_unique`)에 걸려
 * **한 문장이 통째로 실패**하고, 그러면 **메일은 이미 나간 뒤인데 기록이 없어**
 * 내일 또 나간다.
 *
 * 🔴 같은 열쇠가 **한 문장 안에 두 번** 들어오면 Postgres 가 거절한다(「같은 줄을
 * 두 번 고칠 수 없다」). 그 겹침은 여기 오기 전에 걸러진다 — approvals/plan.ts 의
 * `skippedDuplicate`. 여기서 다시 접지 않는 까닭은 접어 버리면 **저쪽이 겹쳐
 * 보내고 있다는 사실이 영영 드러나지 않기** 때문이다(그쪽에서 세어 기록에 남긴다).
 *
 * 🔵 한 사람 몫을 한 문장으로 넣는다. 결재가 열 건이어도 왕복 한 번이다.
 */
export async function recordApprovalMailDeliveries(params: {
  userId: string;
  rows: readonly ApprovalDeliveryRecord[];
}): Promise<void> {
  // 🔴 빈 배열이면 DB 를 건드리지 않는다. drizzle 은 `values([])` 를 오류로 본다.
  if (params.rows.length === 0) return;

  await db
    .insert(approvalMailDeliveries)
    .values(
      params.rows.map((row) => ({
        userId: params.userId,
        clientId: row.clientId,
        itemId: row.itemId,
        kind: row.kind,
        status: row.status,
        error: row.error,
      }))
    )
    .onConflictDoUpdate({
      target: [
        approvalMailDeliveries.userId,
        approvalMailDeliveries.clientId,
        approvalMailDeliveries.itemId,
      ],
      set: {
        status: sql`excluded."status"`,
        kind: sql`excluded."kind"`,
        error: sql`excluded."error"`,
        // 🔴 `excluded."sent_at"` 이 아니다 — 새 줄은 이 칸을 싣지 않는다(칸에
        // 기본값이 있다). 보낸 시각은 지금이므로 DB 에게 직접 묻는다
        // (mutations/notification-kind-purposes.ts 의 같은 자리와 같은 까닭).
        sentAt: sql`now()`,
      },
    });
}
