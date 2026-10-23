import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvalMailKinds } from "@/lib/db/schema";
import { approvalKindKey } from "@/lib/approvals/kinds";

/**
 * 메일을 보내기로 **켜 둔** 갈래의 열쇠(`{client_id}:{kind}`).
 *
 * 🔴 **켜진 것만 돌려준다.** 꺼진 행(`enabled=false`)과 아예 없는 행은 뜻이 같고
 * (db/schema/approval-mail-kinds.ts), 읽는 쪽은 「이 집합에 있는가」만 물어본다
 * (approvals/kinds.ts 의 `isApprovalMailKindEnabled`). 그래서 기본값이 「끔」인
 * 것이 **조회 결과의 모양으로** 지켜진다 — 집합이 비면 아무것도 안 켜진 것이다.
 *
 * 🔴 **던지는 것을 막지 않는다.** 이 조회가 실패했는데 빈 집합을 돌려주면
 * 「아무것도 안 켜져 있다」와 구별되지 않는다. 작업은 조용히 끝나고, 아무도
 * 메일이 안 왔다는 것 말고는 알 수 없다. 부르는 쪽이 그 실패를 보고 멈춘다.
 *
 * 🔵 다섯 줄짜리 표라 통째로 읽는다. 한 시스템치만 읽는 조회는 쓸 데가 없어
 * 두지 않았다 — 메일 작업도 관리자 화면도 다섯을 한꺼번에 본다.
 */
export async function listEnabledApprovalMailKinds(): Promise<Set<string>> {
  const rows = await db
    .select({
      clientId: approvalMailKinds.clientId,
      kind: approvalMailKinds.kind,
    })
    .from(approvalMailKinds)
    .where(eq(approvalMailKinds.enabled, true));

  return new Set(rows.map((row) => approvalKindKey(row.clientId, row.kind)));
}
