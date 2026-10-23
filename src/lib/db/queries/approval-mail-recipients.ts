import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import type { ApprovalMailRecipient } from "@/lib/approvals/run";

/**
 * 결재 알림 메일의 대상 — **지금 쓸 수 있는 계정**(ACTIVE) 전부.
 *
 * 🔴 **메일 주소가 없는 사람도 함께 돌려준다.** 여기서 걸러 내면 「몇 명을 왜
 * 건너뛰었는지」를 셀 수가 없고, 그러면 그 사람은 **아무 표시 없이 영영 메일을
 * 못 받는다.** 거르는 일과 세는 일은 approvals/run.ts 한 곳에서 함께 한다.
 *
 * 🔴 **PENDING · SUSPENDED 는 빼고 읽는다.** 승인 대기 중이거나 정지된 계정은
 * 사내 시스템에 들어갈 수 없으므로 결재도 할 수 없다 — 그 사람에게 가는
 * 「결재할 건이 있습니다」는 할 수 없는 일을 재촉하는 메일이다.
 * 🔵 그리고 각 시스템도 같은 판정을 한다(A/S portal-approvals.ts 의
 * `portalActorCanWork`). 겹치는 것이 맞다.
 *
 * 🔵 이름 차례로 세운다. 작업 기록에 찍히는 차례가 매번 같아야 두 날의 기록을
 * 나란히 놓고 볼 수 있다.
 */
export async function listApprovalMailRecipients(): Promise<ApprovalMailRecipient[]> {
  const rows = await db
    .select({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
    })
    .from(users)
    .where(eq(users.status, "ACTIVE"))
    .orderBy(asc(users.displayName));

  return rows;
}

/**
 * 결재 알림 메일의 대상 **한 사람** — 즉시 알림이 쓴다(approvals/notice-run.ts).
 *
 * 🔴 **위 목록과 같은 규칙이다**: `ACTIVE` 가 아니면 `null` 이고, 메일 주소가
 * 없어도 **돌려준다**(거르는 일과 세는 일은 부르는 쪽 한 곳에서 한다). 둘이
 * 어긋나면 「주기 작업으로는 오는데 즉시로는 안 오는」 사람이 생기고, 그
 * 어긋남은 신고로만 드러난다.
 *
 * 🔴 `getUserById` 를 쓰지 않는 까닭이 그것이다 — 저쪽은 상태와 상관없이
 * 돌려주므로, 쓰는 쪽마다 `status !== "ACTIVE"` 를 다시 적어야 하고 한 자리만
 * 빠지면 정지된 계정에 메일이 간다.
 */
export async function getApprovalMailRecipient(
  userId: string
): Promise<ApprovalMailRecipient | null> {
  const [row] = await db
    .select({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
    })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, "ACTIVE")))
    .limit(1);

  return row ?? null;
}
