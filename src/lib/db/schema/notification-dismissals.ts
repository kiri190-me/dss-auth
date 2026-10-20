import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * 「이 알림은 그만 보겠다」를 적어 두는 곳.
 *
 * 2026-10-19 까지 이 기록은 **각 사이트의 브라우저 저장소**에 있었다. 그런데
 * 브라우저 저장소는 주소(포트)별로 갈려서, A/S(3000)에서 지운 줄이 재고관리
 * (3800)의 종에는 그대로 떴다 — **같은 사람이 시스템마다 다른 목록을 본다.**
 * 그래서 포털 한 곳으로 모은다(설계안 docs/알림-지움-설계-2026-10-19.md 3-1).
 *
 * 🔵 **알림을 쌓는 표가 아니다.** 알림은 어느 시스템에도 저장되지 않고 매 요청
 * 업무 자료에서 다시 계산된다. 여기 쌓이는 것은 **열쇠 문자열뿐**이고, 그 원칙은
 * 그대로다 — 「알림을 저장한다」와 「사람이 지웠다는 뜻을 적는다」는 다른 일이다.
 *
 * 🔴 **수명 칸(만료 시각)을 두지 않았다.** 지움은 로그아웃 때 행을 지워 끝내고
 * (설계안 3-6), 로그아웃을 안 누르고 세션이 만료로 끝난 경우만 `dismissed_at`
 * 이 하루 넘은 행을 `db:purge` 가 걷어 간다. 만료 시각을 따로 들고 있으면 그 둘을
 * 어긋나게 적어 두는 길이 생기는데, 얻는 것이 없다.
 */
export const notificationDismissals = pgTable(
  "notification_dismissals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * 🔴 이 표의 외래키만 `cascade` 다 — 나머지 열둘은 전부 `restrict` 다.
     *
     * 저쪽 열둘은 **감사 로그·권한 부여·로그인 세션·토큰**이라 남아 있어야 할
     * 기록이고, 딸린 것이 있으면 사람 삭제를 **막아 서는 것이 맞다**. 지움 기록은
     * 반대다 — 로그아웃이나 하루면 저절로 없어지는 **임시 표시**라서, 그것이 계정
     * 삭제를 막아 서면 곤란하다.
     *
     * 🔵 지금 포털에는 사람 행을 지우는 코드가 **아예 없으므로** 당장 달라지는
     * 것은 없다. 그래도 적어 두는 까닭은, 이 한 줄만 혼자 다른 것을 본 다음
     * 사람이 「통일성」을 이유로 `restrict` 로 되돌리지 않게 하기 위해서다.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * `{client_id}:{id}` 모양. 어느 시스템이 낸 어느 알림인가를 그 한 줄이 담는다
     * (가르는 규칙은 src/lib/notifications/dismissals.ts 의 parseDismissalKey).
     *
     * 🔵 **길이 상한을 두지 않았다.** 막아야 할 것은 「표가 폭주한다」인데 그것은
     * 글자 수가 아니라 **행 수**로 생기고, 한 요청의 개수 상한(200)이 이미
     * dismissals.ts 에 있다. 글자 수는 라우트가 본문 크기로 막는다. varchar 로
     * 자릿수를 박아 두면 저쪽 시스템이 id 모양을 바꾸는 날 **지움만 조용히 실패**
     * 한다 — 알림은 멀쩡히 뜨므로 아무도 원인을 못 찾는다.
     */
    notificationKey: text("notification_key").notNull(),
    /** 보관 기간(하루)을 재는 기준. db:purge 가 이 칸을 본다(설계안 3-6). */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * 같은 사람이 같은 알림을 두 번 지우면 한 줄이어야 한다. 쓰는 쪽은 이 제약에
     * 기대어 `onConflictDoNothing()` 으로 넘어간다(mutations/notification-dismissals.ts).
     *
     * 🔴 **`user_id` 단독 색인은 일부러 만들지 않았다.** 설계안 3-1 에는
     * `INDEX (user_id)` 가 적혀 있지만 군더더기다 — 이 색인이 `(user_id,
     * notification_key)` 순서라, `user_id` 로만 찾는 조회(listDismissedKeys)도
     * 로그아웃 때 `user_id` 로 지우는 것도 **이 색인을 그대로 쓴다**(왼쪽 앞부분
     * 규칙). 하나 더 두면 쓰기마다 갱신할 것만 는다.
     *
     * 🔵 설계안과 다르게 간 자리라서 적어 둔다. 안 적어 두면 다음 사람이
     * 「빠뜨렸다」고 보고 더한다.
     */
    uniqueIndex("notification_dismissals_unique").on(
      table.userId,
      table.notificationKey
    ),
  ]
);
