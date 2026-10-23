import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvalInboxViews } from "@/lib/db/schema";

/**
 * 그 사람이 통합 승인함을 **마지막으로 연 때**. 한 번도 안 열었으면 `null`.
 *
 * ── 🔴 「한 번도 안 열었다」와 「못 읽었다」를 가른다 ──────────────────────
 * 이 함수가 하는 일의 전부가 그 구분이다.
 *
 *  · **줄이 없다(`null`)** — 한 번도 안 연 사람이다. 결재가 하나라도 있으면
 *    점을 띄워야 한다(approvals/tile-dot.ts).
 *  · **던진다** — DB 를 못 읽었다. 점을 띄우면 **안 된다.** 기준을 모르는 채로
 *    「한 번도 안 열었다」와 같이 다루면, DB 가 흔들리는 동안 **전 직원의 타일에
 *    빨간 점**이 뜨고 들어가 보면 아무것도 없다. 점이 한 번 거짓말하면 그 다음부터
 *    진짜 점도 안 믿는다.
 *
 * 그래서 여기서 try/catch 로 `null` 을 만들지 않는다. 부르는 쪽이 「못 쟀다」로
 * 받아 **조용히 점을 끈다**(approvals/screen-service.ts).
 * queries/notification-dismissals.ts 가 같은 까닭으로 같은 선택을 했다.
 */
export async function readApprovalInboxSeenAt(userId: string): Promise<Date | null> {
  const rows = await db
    .select({ seenAt: approvalInboxViews.seenAt })
    .from(approvalInboxViews)
    .where(eq(approvalInboxViews.userId, userId))
    .limit(1);

  return rows[0]?.seenAt ?? null;
}
