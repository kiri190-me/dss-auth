import "server-only";
import { db } from "@/lib/db/client";
import { approvalInboxViews } from "@/lib/db/schema";

/**
 * 「이 사람이 승인함을 열었다」를 적는다. 🔴 **이 저장소에서 `seen_at` 을 쓰는
 * 코드는 이 함수 하나뿐이다.**
 *
 * ── 🔴 밤에 도는 메일 작업은 이 함수를 부르지 않는다 ──────────────────────
 * 결재 알림 메일(approvals/run.ts → service.ts)은 **아무도 안 보는 동안** 세
 * 시스템에 결재를 묻는다. 거기서 이 함수가 불리면 **아침마다 점이 사라져**
 * 아무도 새 결재를 모른다 — 「묻는 것」과 「사람이 본 것」은 다른 일이다.
 * 그 울타리는 글로만 지키지 않는다: 메일 쪽 배선에서 이 모듈에 닿는 길이
 * 하나도 없다는 것을 시험이 들머리부터 따라가며 잰다
 * (approvals/mail-seen-fence.test.ts).
 *
 * ── 왜 upsert 인가 ────────────────────────────────────────────────────────
 * 한 사람에 한 줄이고(schema/approval-inbox-views.ts), 처음 여는 사람에게는
 * 줄이 없다. 「있으면 UPDATE 없으면 INSERT」를 코드로 가르면 두 번 동시에 열 때
 * 둘 다 INSERT 로 갈라져 기본키 충돌로 **한쪽이 500** 이 된다.
 *
 * 🔵 **값을 앞으로만 밀지는 않는다**(`greatest` 를 쓰지 않는다). 요청 둘이 겹치면
 * 나중에 도착한 쪽이 조금 **이른** 시각을 덮어쓸 수 있는데, 그래 봐야 그 둘이
 * 시작한 시간 차(최대 몇 초)만큼이고 **점이 한 번 더 뜨는 쪽**이라 안전하다.
 * 거꾸로(점이 덜 뜨는 쪽)였다면 `greatest` 를 썼을 것이다.
 *
 * 🔴 **던질 수 있다.** 부르는 쪽이 받아 삼킨다 — 점 하나 때문에 승인함 화면이
 * 못 뜨면 안 된다(approvals/screen-request.ts).
 *
 * @param seenAt 승인함을 연 시각. 🔴 **결재함을 모으기 전**에 잰 값이어야 한다
 *               (schema 의 `seenAt` 주석).
 */
export async function markApprovalInboxSeen(userId: string, seenAt: Date): Promise<void> {
  // 🔴 사람을 모르면 아무것도 적지 않는다. uuid 칸이라 빈 문자열은 어차피
  //    INSERT 가 깨지지만, 그때 깨지는 자리가 「승인함을 못 연다」라서 미리 막는다.
  if (!userId) return;

  await db
    .insert(approvalInboxViews)
    .values({ userId, seenAt })
    .onConflictDoUpdate({ target: approvalInboxViews.userId, set: { seenAt } });
}
