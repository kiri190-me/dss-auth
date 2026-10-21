import "server-only";
import { eq, inArray } from "drizzle-orm";
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

/**
 * **여러 시스템치를 한 번에.** `clientId → (kind → 분류)`.
 *
 * ── 🔴 왜 위 함수를 고치지 않고 하나 더했는가 ──────────────────────────────
 * 위 `listKindPurposes` 는 관리자 화면과 저장 액션이 쓰는 **한 시스템치** 조회고,
 * 그 둘은 돌려받는 모양이 `Map<kind, 분류>` 인 데 기대어 있다. 서명을 바꾸면
 * 이번 조각과 상관없는 화면·저장 길이 함께 흔들린다. 뜻이 다른 물음이므로
 * 함수도 따로 둔다.
 *
 * ── 🔴 왜 시스템마다 한 번씩 부르지 않는가 ────────────────────────────────
 * 이 조회를 쓰는 곳은 **종을 그릴 때마다 도는 길**이다(notifications/service.ts·
 * site-service.ts 의 거르기). 목록에는 시스템 다섯의 줄이 섞여 있을 수 있어,
 * 시스템마다 부르면 종 한 번에 DB 왕복이 다섯이다. 🔵 그리고 그 다섯 번은
 * **캐시 바깥**에서 돈다(아래) — 캐시가 덜어 주지도 못한다.
 *
 * ── 🔴 이 값을 캐시에 넣지 마라 ───────────────────────────────────────────
 * 거르기는 캐시 **바깥**에서 요청마다 돈다(거르지 않은 feed 만 캐시에 들어간다 —
 * notifications/service.ts). 분류도 그 바깥에서 읽어야 **관리자가 분류를 바꾼
 * 즉시** 반영된다. 안에 넣으면 「분류를 바꿨는데 종이 30초 동안 옛 규칙대로
 * 돈다」가 되고, 그 30초는 설명할 말이 없다.
 *
 * 🔴 **있는 행만 돌려준다.** 없는 시스템은 열쇠조차 없고, 없는 종류는 값이 없다.
 * 기본값(`ACTION`)을 채우는 자리는 purposes.ts 의 `purposeOf` 하나다 — 위 함수의
 * 그 주석과 같은 까닭이다.
 */
export async function listKindPurposesByClient(
  clientIds: readonly string[]
): Promise<Map<string, Map<string, NotificationPurpose>>> {
  const byClient = new Map<string, Map<string, NotificationPurpose>>();

  // 🔴 빈 목록이면 DB 를 건드리지 않는다. `inArray(x, [])` 는 drizzle 이
  // 「언제나 거짓」으로 펴 주지만, 알림이 한 줄도 없는 사람마다 왕복을 한 번씩
  // 쓸 까닭이 없다. 돌려줄 답도 빈 Map 하나로 정해져 있다.
  if (clientIds.length === 0) return byClient;

  const rows = await db
    .select({
      clientId: notificationKindPurposes.clientId,
      kind: notificationKindPurposes.kind,
      purpose: notificationKindPurposes.purpose,
    })
    .from(notificationKindPurposes)
    .where(inArray(notificationKindPurposes.clientId, [...clientIds]));

  for (const row of rows) {
    let kinds = byClient.get(row.clientId);
    if (!kinds) {
      kinds = new Map<string, NotificationPurpose>();
      byClient.set(row.clientId, kinds);
    }
    // 🔴 모르는 글자는 여기서 `ACTION` 으로 떨어진다(purposes.ts 의
    // toNotificationPurpose). DB 에 CHECK 를 걸지 않은 근거가 이것이다.
    kinds.set(row.kind, toNotificationPurpose(row.purpose));
  }

  return byClient;
}
