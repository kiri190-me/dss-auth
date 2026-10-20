import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { notificationDismissals } from "@/lib/db/schema";

/**
 * 그 사람이 지운 알림의 열쇠 전부.
 *
 * 🔴 **`Set` 으로 돌려준다.** 받는 쪽이 `applyDismissals(feed, dismissed:
 * ReadonlySet<string>)` 라 그대로 들어간다. 배열로 돌려주면 부르는 자리마다
 * `new Set(...)` 이 생기고, 그 자리는 하나가 아니다 — 종과 사이트별 응답이
 * 각각 거른다.
 *
 * 🔵 **매 요청 새로 읽는다. 캐시하지 않는다.** 포털의 30초 캐시에는 **거르지
 * 않은** feed 가 들어가고, 꺼낸 뒤 응답 직전에 이것으로 거른다(설계안 3-2).
 * 거른 결과를 캐시하면 「지웠는데 30초 남는다」가 되고, 캐시 무효화가 필요해진다.
 * 이쪽은 사람 한 명치에 색인 하나라서 매번 읽어도 싸다.
 *
 * ── 🔴 던지는 것을 막지 않는다 ─────────────────────────────────────────────
 * try/catch 로 감싸 빈 `Set` 을 돌려주고 싶어지지만 그러지 않는다. 「DB 가
 * 죽었다」와 「지운 것이 없다」는 다른 일인데 여기서 뭉개면 **지운 적도 없는 줄이
 * 전부 다시 뜨는** 상태가 되고, 오류는 어디에도 안 남는다. 신고가 들어와도
 * 「지웠는데 다시 뜬다」 하나뿐이라 DB 를 의심할 단서가 없다. 부르는 쪽이 이
 * 예외를 어떻게 다룰지(알림을 통째로 접을지, degraded 로 표시할지)는 그쪽이 정한다.
 */
export async function listDismissedKeys(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ notificationKey: notificationDismissals.notificationKey })
    .from(notificationDismissals)
    .where(eq(notificationDismissals.userId, userId));

  return new Set(rows.map((row) => row.notificationKey));
}
