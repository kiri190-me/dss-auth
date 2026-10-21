import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { notificationKindPurposes } from "@/lib/db/schema";
import {
  toNotificationPurpose,
  type NotificationPurpose,
} from "@/lib/notifications/purposes";

/**
 * 그 시스템에 저장된 분류 전부.
 *
 * 🔴 **있는 행만 돌려준다. 없는 종류를 기본값으로 채우지 않는다.** 채우려면 이
 * 함수가 「그 시스템에 어떤 종류가 있는가」를 알아야 하는데, 그 목록은 포털에
 * 없다 — 저쪽이 설정을 내줄 때 함께 보내 준다(notifications/settings.ts 머리말).
 * 대신 **읽는 쪽이 `purposeOf(stored, kind)` 로 채운다**. 기본값을 쓰는 자리가
 * 거기 하나뿐이라, 기본값을 바꿀 일이 생겨도 고칠 곳이 하나다.
 *
 * 🔵 돌려주는 것은 `Map` 이다. 쓰는 쪽(화면·저장 액션) 둘 다 종류 코드로 하나씩
 * 꺼내 보고, 그 코드는 **저쪽이 보낸 글자**라 평범한 객체에 담으면 `__proto__`
 * 같은 이름이 칸을 못 만들고 조용히 삼켜진다(settings-form.ts 가 fromEntries 를
 * 쓰는 것과 같은 까닭).
 *
 * 🔴 **모르는 글자는 여기서 `ACTION` 으로 떨어진다**(purposes.ts 의
 * toNotificationPurpose). DB 에 CHECK 를 걸지 않은 근거가 이것이다.
 *
 * 🔴 **던지는 것을 막지 않는다.** 이 조회가 실패했는데 빈 Map 을 돌려주면 화면이
 * 전부 「승인용」으로 보이고, 그대로 저장을 누르면 사람이 정해 둔 분류가 통째로
 * 덮인다. 포털 DB 가 죽었다면 이 화면은 애초에 뜨지 않는다 — requirePortalAdmin
 * 이 같은 DB 를 먼저 읽는다.
 */
export async function listKindPurposes(
  clientId: string
): Promise<Map<string, NotificationPurpose>> {
  const rows = await db
    .select({
      kind: notificationKindPurposes.kind,
      purpose: notificationKindPurposes.purpose,
    })
    .from(notificationKindPurposes)
    .where(eq(notificationKindPurposes.clientId, clientId));

  return new Map(rows.map((row) => [row.kind, toNotificationPurpose(row.purpose)]));
}
