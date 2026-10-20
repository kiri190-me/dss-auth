import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { notificationDismissals } from "@/lib/db/schema";

/**
 * 지운 알림을 적는다. 열쇠는 이미 검사를 마친 것들이다
 * (src/lib/notifications/dismissals.ts 의 readDismissalKeys).
 *
 * 🔴 **한 문장으로 넣는다.** 한 요청의 열쇠가 최대 200개인데(같은 파일의
 * `MAX_DISMISSAL_KEYS_PER_REQUEST`) 줄마다 `insert` 를 부르면 왕복이 200번이다.
 * 「보이는 알림 전부 지우기」 한 번이 그만큼 걸리면 사람은 화면이 멈췄다고 본다.
 *
 * 🔴 **`onConflictDoNothing()` 이 없으면 일괄 전체가 실패한다.** `(user_id,
 * notification_key)` 가 한 쌍뿐이라 같은 알림을 두 번 지우면 오류가 나고, 한
 * 문장이므로 **나머지 199개까지 같이 되돌아간다.** 두 번 지우는 일은 정상적으로
 * 일어난다 — 화면 둘에서 눌렀거나, 응답이 늦어 재시도했거나. 그리고 두 번 지우는
 * 것은 한 번 지우는 것과 **뜻이 같으니** 조용히 넘어가는 것이 맞다.
 * 🔵 겨눌 제약을 적지 않았다. 이 표의 유일 제약은 그 한 쌍뿐이고, `id` 는
 * `defaultRandom()` 이라 부딪힐 일이 없다.
 *
 * 🔵 트랜잭션으로 감싸지 않았다. insert 한 문장이 이미 원자적이고, 여기서 하는
 * 일은 그 한 문장뿐이다.
 */
export async function recordDismissals(
  userId: string,
  keys: readonly string[]
): Promise<void> {
  // 🔴 빈 배열이면 DB 를 건드리지 않는다. drizzle 은 `values([])` 를 오류로 본다 —
  // 넣을 칸이 없어 SQL 을 지을 수 없기 때문이다. 「지울 것이 없다」는 사고가
  // 아니므로 조용히 돌아간다.
  if (keys.length === 0) return;

  await db
    .insert(notificationDismissals)
    .values(keys.map((notificationKey) => ({ userId, notificationKey })))
    .onConflictDoNothing();
}

/**
 * 그 사람의 지움 기록을 전부 지운다 — 로그아웃 때 쓴다(설계안 3-6).
 *
 * 「로그아웃하면 지운 알림이 다시 뜬다」가 브라우저에 적던 시절의 동작이었고,
 * 포털로 옮기면서도 그 뜻을 그대로 지킨다. 포털 로그아웃은 백채널로 모든 시스템에
 * 전파되므로 기준이 한 곳이다.
 */
export async function clearDismissals(userId: string): Promise<void> {
  // 🔴 빈 문자열이면 아무것도 하지 않는다. 조건이 비어 **표 전체가 날아가는**
  // 사고를 막는다 — uuid 칸이라 빈 문자열은 어차피 한 행도 못 맞히지만, 부르는
  // 쪽에서 사람 번호를 못 구한 채 넘어오는 길이 생기면 그때 막아 주는 것은
  // 여기뿐이다. 값이 비싸지 않고 막는 사고는 되돌릴 수 없다.
  if (!userId) return;

  await db
    .delete(notificationDismissals)
    .where(eq(notificationDismissals.userId, userId));
}
