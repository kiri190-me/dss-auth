import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { notificationKindPurposes } from "@/lib/db/schema";
import type { NotificationKindPurposeChange } from "@/lib/notifications/purposes";

/**
 * 바뀐 분류를 적는다. 들어오는 줄은 이미 **달라진 것만** 골라진 뒤다
 * (notifications/purposes.ts 의 diffSubmittedPurposes).
 *
 * 🔴 **있으면 고치고 없으면 넣는다(upsert).** 「먼저 읽어 보고 없으면 insert」로
 * 가면 두 사람이 같은 종류를 동시에 저장할 때 한쪽이 유일 제약에 걸려 실패하고,
 * 한 문장이라 **같이 보낸 나머지 줄까지 통째로 되돌아간다.** 제약에 기대는 쪽이
 * 읽기 한 번도 덜 돈다 — mutations/notification-dismissals.ts 가
 * `onConflictDoNothing()` 에 기대는 것과 같은 결이고, 다른 것은 하나다:
 * 지움은 두 번 눌러도 뜻이 같아 **넘어가면** 되지만, 분류는 **덮어써야** 한다.
 *
 * 🔵 `excluded` 는 들어오려다 부딪힌 그 줄이다. 값 하나를 바인딩으로 박지 않는
 * 까닭: 한 문장에 여러 줄이 실려 오므로 줄마다 값이 다르다.
 *
 * 🔵 트랜잭션으로 감싸지 않았다. insert 한 문장이 이미 원자적이고, 여기서 하는
 * 일은 그 한 문장뿐이다.
 */
export async function saveKindPurposes(params: {
  clientId: string;
  changes: readonly NotificationKindPurposeChange[];
  /**
   * 누가 고쳤는가. 🔵 null 을 받을 수 있게 열어 둔 것이 아니라, 칸이 null 을
   * 허용할 뿐이다 — 사람이 지워지면 그때 DB 가 비운다(스키마의 `set null`).
   */
  updatedBy: string;
}): Promise<void> {
  // 🔴 빈 배열이면 DB 를 건드리지 않는다. drizzle 은 `values([])` 를 오류로 본다.
  if (params.changes.length === 0) return;

  await db
    .insert(notificationKindPurposes)
    .values(
      params.changes.map((change) => ({
        clientId: params.clientId,
        kind: change.kind,
        purpose: change.purpose,
        updatedBy: params.updatedBy,
      }))
    )
    .onConflictDoUpdate({
      target: [notificationKindPurposes.clientId, notificationKindPurposes.kind],
      set: {
        purpose: sql`excluded."purpose"`,
        updatedBy: sql`excluded."updated_by"`,
        // 🔴 `excluded."updated_at"` 이 아니다. 새 줄은 이 칸을 싣지 않아(칸에
        // 기본값이 있다) excluded 쪽 값이 비어 들어올 수 있다. 고친 시각은
        // 지금이므로 DB 에게 직접 묻는다.
        updatedAt: sql`now()`,
      },
    });
}
