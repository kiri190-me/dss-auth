import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * ============================================================================
 * 「이 알림은 해소됐다」를 **영구히** 적어 두는 곳
 * ============================================================================
 * 옆의 `notification_dismissals` 와 **뜻이 다르다.** 모양은 일부러 닮게 두었지만
 * 섞어 읽으면 안 된다:
 *
 *   ✕ 지움 — 「지금은 그만 보겠다」. 로그아웃하면 **돌아온다**(그 표는 로그아웃
 *             때 통째로 비워진다 — mutations/notification-dismissals.ts).
 *   ✓ 확인 — 「해소됐다」. 로그아웃해도 **안 돌아온다.** 그래서 이 표다.
 *
 * 🔴 **✕ 의 동작은 이 표가 생겨도 그대로다.** 쓰는 분이 2026-10-21 에 「[X]기능은
 * 지금대로 남겨 달라」고 분명히 말했다. 두 표가 나란히 살고, 거를 때 둘 다 본다.
 *
 * ── 🔴 같은 이름의 표가 다른 DB 에도 있다 ──────────────────────────────────
 * A/S(RF_Service_System)·개선요청·사내 게시판에도 `notification_acknowledgements`
 * 가 있다. **그쪽 DB 의 다른 표다.** 그쪽은 제 시스템 알림만 다루므로 열쇠에
 * 시스템 접두사가 없고(`{id}` 뿐), 이쪽 열쇠는 `{client_id}:{id}` 다.
 *
 * 🔵 뜻이 같은 것을 다른 이름으로 부르면 더 헷갈리므로 **일부러 같은 이름**을
 * 쓴다. 다만 다음 사람이 「한쪽으로 합치자」고 생각하지 않도록 여기 적어 둔다 —
 * 합칠 수 없다. 포털은 각 시스템의 DB 를 모르고(notifications/service.ts 머리말),
 * 각 시스템은 남의 시스템 알림을 모른다.
 *
 * ── 🔴 보관 기간을 두지 않았다 (retention.ts 에 넣지 않는다) ────────────────
 * 까닭 둘:
 *
 *  ① **사람당 행 수에 상한이 있다.** 유일 색인이 `(user_id, notification_key)`
 *     하나라 같은 알림을 몇 번 확인해도 행은 하나다(내용이 바뀌면 덮어쓴다).
 *     쌓이는 양은 「그 사람이 본 적 있는 알림의 가짓수」로 묶여 있다.
 *
 *  ② 🔴 **포털의 기존 보관 기간이 운영에서 한 번도 안 돌고 있다.** 걷는 명령
 *     (`npm run db:purge`)이 NAS 야간 작업표에 없다 — 지움 표의 「하루 뒤 삭제」
 *     (retention.ts 의 NOTIFICATION_DISMISSAL_RETENTION_DAYS)도, 감사 로그 3년도
 *     실제로는 한 번도 걷힌 적이 없다. **안 도는 청소에 기대는 설계를 하나 더
 *     만들지 않는다.** 이 표는 청소가 없어도 옳게 동작해야 하고, 위 ① 때문에
 *     실제로 그렇다.
 *
 * 🔵 그러니 뒷날 `db:purge` 가 야간에 돌기 시작해도 **이 표는 거기 넣지 마라.**
 * 확인은 임시 표시가 아니라 사람이 내린 판단이고, 걷어 가면 그 알림이 다시 뜬다.
 * ============================================================================
 */
export const notificationAcknowledgements = pgTable(
  "notification_acknowledgements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * 🔴 `cascade` 다 — 지움 표와 **같은 판단**이고, 같은 까닭이다.
     *
     * 포털의 외래키 열셋 가운데 `restrict` 인 것들은 **감사 로그·권한 부여·로그인
     * 세션·토큰**이다. 남아 있어야 할 기록이라 딸린 것이 있으면 사람 삭제를 막아
     * 서는 것이 맞다. 확인 기록은 그쪽이 아니다 — **그 사람에게만 뜻이 있는
     * 표시**라서, 사람이 지워지면 함께 지워지는 것이 맞고 **계정 삭제를 막아
     * 서면 곤란하다.**
     *
     * 🔵 「영구히 남는다」는 **로그아웃·보관 기간에 대해서** 하는 말이지 계정이
     * 지워진 뒤까지라는 뜻이 아니다. 그 둘을 섞어 읽고 `restrict` 로 바꾸면
     * 계정 삭제가 알림 표시 한 줄에 막힌다.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * `{client_id}:{id}` 모양. 🔴 **지움 표와 같은 모양이고 같은 함수로 가른다**
     * (notifications/dismissals.ts 의 parseDismissalKey — 첫 `:` 에서만 가른다).
     *
     * 🔵 길이 상한을 두지 않은 까닭도 저쪽과 같다. varchar 로 자릿수를 박으면
     * 저쪽 시스템이 id 모양을 바꾸는 날 **확인만 조용히 실패**한다.
     */
    notificationKey: text("notification_key").notNull(),
    /**
     * 🔴 **확인한 그 순간의 내용**을 줄인 값. 계산은
     * notifications/acknowledgements.ts 의 `contentDigest` 하나다.
     *
     * ── 왜 이 칸이 있는가 ──────────────────────────────────────────────────
     * 알림 id 가 **고정인 줄**이 실제로 있다. 재고관리의 「한계수량 이하인 부품이
     * N종 더 있습니다」는 id 가 늘 `PARTS_LOW_STOCK_MORE` 다(dss-inventory 의
     * bell-items.ts). 내용을 안 보고 열쇠만으로 영구히 없애면 **3종이 10종이
     * 되어도 영영 안 보인다.** 그래서 확인은 「그 알림」이 아니라 **「그 내용」에
     * 대한 확인**이고, 내용이 달라지면 다시 떠야 한다.
     *
     * 🔴 **보내온 값을 그대로 적지 않는다.** 사이트는 열쇠만 보내고 지문은 포털이
     * 제 목록에서 직접 계산한다(site-acknowledgements.ts 에 까닭이 길게 적혀 있다).
     */
    contentDigest: text("content_digest").notNull(),
    /**
     * 언제 확인했는가.
     *
     * 🔵 **보관 기간을 재는 기준이 아니다**(위 머리말 ②). 지움 표의
     * `dismissed_at` 과 모양은 같지만 쓰임이 다르다 — 이 칸을 보고 행을 걷어 가는
     * 코드는 없어야 한다. 남겨 두는 까닭은 「언제부터 안 보이던 것인가」를 뒤에
     * 물어보게 되기 때문이다.
     */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * 같은 사람의 같은 알림은 한 줄이다.
     *
     * 🔴 **`content_digest` 를 이 색인에 넣지 마라.** 넣으면 내용이 바뀔 때마다
     * 행이 하나씩 쌓이고, 그 순간 위 머리말 ①(「행 수에 상한이 있다」)이 거짓이
     * 된다 — 보관 기간이 없는 표에서 그것은 곧 무한히 자라는 표다. 그리고 옛
     * 내용의 확인 기록은 아무도 쓰지 않는다. **같은 열쇠면 덮어쓴다**(새 내용을
     * 확인한 것이다 — mutations/notification-acknowledgements.ts 가 이 제약에
     * 기대어 upsert 한다).
     *
     * 🔵 `user_id` 단독 색인은 두지 않았다. 이 색인이 `(user_id,
     * notification_key)` 순서라 사람 하나치를 통째로 읽는 조회
     * (listAcknowledgedDigests)도 왼쪽 앞부분 규칙으로 그대로 쓴다 —
     * notification_dismissals 와 같은 판단이다.
     */
    uniqueIndex("notification_acknowledgements_unique").on(
      table.userId,
      table.notificationKey
    ),
  ]
);
