import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvalMailKinds } from "@/lib/db/schema";
import type { ApprovalMailKindChange } from "@/lib/approvals/kinds";

/**
 * 바뀐 스위치를 적는다. 들어오는 줄은 이미 **달라진 것만** 골라진 뒤다
 * (approvals/kinds.ts 의 `diffSubmittedApprovalKinds`).
 *
 * 🔴 **있으면 고치고 없으면 넣는다(upsert).** 「먼저 읽어 보고 없으면 insert」로
 * 가면 두 사람이 같은 갈래를 동시에 저장할 때 한쪽이 유일 제약에 걸려 실패하고,
 * 한 문장이라 **같이 보낸 나머지 줄까지 통째로 되돌아간다.**
 * mutations/notification-kind-purposes.ts 와 같은 모양이다.
 *
 * 🔵 `excluded` 는 들어오려다 부딪힌 그 줄이다. 값을 바인딩으로 박지 않는 까닭:
 * 한 문장에 여러 줄이 실려 오므로 줄마다 값이 다르다.
 *
 * 🔵 트랜잭션으로 감싸지 않았다. insert 한 문장이 이미 원자적이고, 여기서 하는
 * 일은 그 한 문장뿐이다.
 */
export async function saveApprovalMailKinds(params: {
  changes: readonly ApprovalMailKindChange[];
  /** 누가 켜고 껐는가. 사람이 지워지면 DB 가 비운다(스키마의 `set null`). */
  updatedBy: string;
}): Promise<void> {
  // 🔴 빈 배열이면 DB 를 건드리지 않는다. drizzle 은 `values([])` 를 오류로 본다.
  if (params.changes.length === 0) return;

  await db
    .insert(approvalMailKinds)
    .values(
      params.changes.map((change) => ({
        clientId: change.clientId,
        kind: change.kind,
        enabled: change.enabled,
        updatedBy: params.updatedBy,
      }))
    )
    .onConflictDoUpdate({
      target: [approvalMailKinds.clientId, approvalMailKinds.kind],
      set: {
        enabled: sql`excluded."enabled"`,
        updatedBy: sql`excluded."updated_by"`,
        // 🔴 `excluded."updated_at"` 이 아니다. 새 줄은 이 칸을 싣지 않아(칸에
        // 기본값이 있다) excluded 쪽 값이 비어 들어올 수 있다. 고친 시각은
        // 지금이므로 DB 에게 직접 묻는다.
        updatedAt: sql`now()`,
      },
    });
}
