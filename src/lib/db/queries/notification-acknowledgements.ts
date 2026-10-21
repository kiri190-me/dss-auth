import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { notificationAcknowledgements } from "@/lib/db/schema";

/**
 * 그 사람이 확인한 알림 — `notification_key → 그때 본 내용의 지문`.
 *
 * 🔴 **`Set` 이 아니라 `Map` 이다.** 지움과 다른 점이 여기다 — 지움은 「열쇠가
 * 있는가」만 물으면 끝이지만, 확인은 **그때 본 내용과 지금 내용이 같은가**까지
 * 봐야 한다(notifications/acknowledgements.ts 의 조건 ②). 열쇠만 들고 오면 그
 * 판단을 아예 할 수 없고, 「N종 더」가 3종에서 10종이 되어도 영영 안 보인다.
 *
 * 🔵 **매 요청 새로 읽는다. 캐시하지 않는다.** 포털의 30초 캐시에는 **거르지
 * 않은** feed 가 들어가고, 꺼낸 뒤 응답 직전에 이것으로 거른다 — 지움과 같은
 * 모양이다(queries/notification-dismissals.ts). 사람 한 명치에 색인 하나라 싸다.
 *
 * 🔴 **던지는 것을 막지 않는다.** try/catch 로 감싸 빈 Map 을 돌려주면 「DB 가
 * 죽었다」와 「확인한 것이 없다」가 한 얼굴이 되고, 증상은 「확인했는데 다시
 * 뜬다」 하나뿐이라 DB 를 의심할 단서가 없다. 부르는 쪽이 degraded 로 표시할지
 * 말지를 정한다(notifications/service.ts).
 */
export async function listAcknowledgedDigests(userId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      notificationKey: notificationAcknowledgements.notificationKey,
      contentDigest: notificationAcknowledgements.contentDigest,
    })
    .from(notificationAcknowledgements)
    .where(eq(notificationAcknowledgements.userId, userId));

  return new Map(rows.map((row) => [row.notificationKey, row.contentDigest]));
}
