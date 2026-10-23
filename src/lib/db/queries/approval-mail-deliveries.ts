import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvalMailDeliveries } from "@/lib/db/schema";
import { approvalDeliveryKey } from "@/lib/approvals/plan";

/**
 * 이 사람에게 **이미 보낸** 결재건들의 열쇠(`{client_id}:{item_id}`).
 *
 * 🔴 **`SENT` 인 줄만 센다.** 실패(`FAILED`)로 남은 줄은 「보냈다」가 아니므로
 * 다음 번에 다시 보낸다 — 그것이 실패를 지우지 않고 남겨 두는 까닭이다
 * (db/schema/approval-mail-deliveries.ts). 모르는 글자가 들어 있어도 같은 규칙에
 * 따라 「아직 안 보냄」 쪽으로 떨어진다: 메일이 한 번 더 갈 뿐, 놓치지 않는다.
 *
 * 🔴 **그 사람 것만 읽는다.** 열쇠 글자에는 사람이 들어 있지 않으므로(두
 * 칸뿐이다), 사람을 섞지 않는 책임이 이 `where` 한 줄에 있다.
 *
 * 🔵 색인은 `(user_id, client_id, item_id)` 유일 색인의 왼쪽 앞부분을 그대로
 * 쓴다 — `user_id` 단독 색인을 따로 두지 않은 까닭이다.
 *
 * 🔴 **던지는 것을 막지 않는다.** 여기서 빈 집합을 돌려주면 **이미 보낸 메일이
 * 전부 다시 나간다.** 부르는 쪽(approvals/run.ts)이 그 사람 차례를 실패로 적고
 * 넘어간다 — 오늘 한 사람이 메일을 못 받는 것이, 모두가 같은 메일을 또 받는
 * 것보다 낫다.
 */
export async function listSentApprovalKeys(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      clientId: approvalMailDeliveries.clientId,
      itemId: approvalMailDeliveries.itemId,
    })
    .from(approvalMailDeliveries)
    .where(
      and(
        eq(approvalMailDeliveries.userId, userId),
        eq(approvalMailDeliveries.status, "SENT")
      )
    );

  return new Set(rows.map((row) => approvalDeliveryKey(row.clientId, row.itemId)));
}
