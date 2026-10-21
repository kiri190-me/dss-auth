import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * 알림 종류마다 「정보 확인용인가, 승인용인가」를 적어 두는 곳.
 *
 * 🔴 **알림 설정 가운데 포털이 직접 갖는 유일한 값이다.** 나머지(사용·역할)는
 * 각 시스템이 갖고 포털은 물어서 그릴 뿐이다(notifications/settings.ts 머리말,
 * 설계서 D-5). 여기서만 그 원칙에서 벗어나는 까닭:
 *
 * 알림 통로를 연 시스템 다섯 가운데 **설정을 실제로 바꿀 수 있는 곳은 A/S 하나
 * 뿐이다.** 휴가·개선요청·게시판·재고관리는 모든 칸이 `editable: false` 이고
 * 저장을 보내면 403 으로 거절한다(예: dss-inventory 의 writePortalNotificationSettings
 * ——「저장할 표가 없다」). 분류까지 저쪽에 맡기면 **넷은 영영 고칠 수 없다.**
 * 포털이 가지면 그 시스템이 뭐라 하든 다섯 곳 모두 고칠 수 있다.
 *
 * 🔵 그러면서도 저쪽 어휘를 포털로 들이지는 않는다 — 여기 쌓이는 것은 **저쪽이
 * 보낸 종류 코드와 두 글자뿐**이고, 종류 목록도 이름도 여전히 그 시스템이 정한다.
 */
export const notificationKindPurposes = pgTable(
  "notification_kind_purposes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * 어느 시스템의 알림인가. 값은 `clients.client_id` 와 같은 글자다.
     *
     * 🔴 **외래키를 걸지 않았다.** 알림 통로를 가진 시스템 목록을 정하는 것은
     * `clients` 표가 아니라 상수 하나다(notifications/sources.ts 의
     * NOTIFICATION_SOURCE_PATHS — 2026-10-13 에 「표로 옮기지 않고 상수로 둔다」로
     * 결론이 났다). 외래키를 걸면 그 둘이 어긋나는 날 — 시스템을 지웠다 다시
     * 등록하거나, 상수에만 있고 `clients` 에 아직 없는 동안 — **설정이 조용히
     * 사라진다.** 오류도 안 나고 화면만 기본값으로 돌아가 있어 아무도 신고하지
     * 않는다. `notification_dismissals` 도 같은 이유로 `client_id` 를 열쇠 글자
     * 안에 담을 뿐 외래키를 두지 않았다.
     */
    clientId: text("client_id").notNull(),
    /**
     * 알림 종류 코드. 저쪽이 보낸 글자 그대로다(PortalSettingsKind.kind).
     *
     * 🔵 길이 상한을 두지 않은 까닭은 notification_dismissals 와 같다 — varchar 로
     * 자릿수를 박으면 저쪽이 코드 모양을 바꾸는 날 **분류 저장만 조용히 실패**한다.
     */
    kind: text("kind").notNull(),
    /**
     * `INFO`(정보 확인용) 또는 `ACTION`(승인용).
     *
     * 🔴 **CHECK 도 pgEnum 도 걸지 않았다.** 까닭 둘:
     *  ① 값을 늘릴 때 마이그레이션이 깨진다. `ALTER TYPE … ADD VALUE` 는 같은
     *     트랜잭션 안에서 그 값을 쓸 수 없고, CHECK 를 고치는 것은 표 전체를
     *     다시 훑는 일이다. 셋째 분류가 생기는 날 그 함정이 그대로 걸린다.
     *  ② 제약이 없어도 사고가 나지 않는다. 읽는 쪽이 **모르는 글자를 안전한
     *     쪽(`ACTION`)으로 떨어뜨린다**(notifications/purposes.ts 의
     *     toNotificationPurpose). 즉 이 칸의 안전은 제약이 아니라 읽기가 지킨다.
     */
    purpose: text("purpose").notNull(),
    /**
     * 마지막으로 이 값을 고친 사람.
     *
     * 🔴 **`set null` 이다 — `cascade` 도 `restrict` 도 아니다.** 설정은 조직의
     * 규칙이라 사람이 지워져도 **값은 남아야 한다**(cascade 면 그 사람이 정한
     * 분류가 통째로 사라진다). 그렇다고 설정 한 줄이 계정 삭제를 **막아 서도**
     * 곤란하다(restrict). 누가 바꿨는지만 잃고 값은 남는 것이 맞다.
     *
     * 🔵 그래서 null 을 허용한다. 「아직 아무도 안 고쳤다」가 아니라 「고친 사람이
     * 지워졌다」는 뜻이다 — 고친 적 없는 종류는 애초에 행이 없다.
     */
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** 언제 고쳤는가. 🔵 보관 기간이 없다 — 설정은 걷어 가는 자료가 아니다. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * 한 시스템의 한 종류에 분류는 하나뿐이다. 쓰는 쪽이 이 제약에 기대어
     * 「있으면 고치고 없으면 넣는다」로 간다(mutations/notification-kind-purposes.ts).
     *
     * 🔵 `client_id` 단독 색인은 두지 않았다. 이 색인이 `(client_id, kind)` 순서라
     * 한 시스템치를 통째로 읽는 조회(listKindPurposes)도 왼쪽 앞부분 규칙으로
     * 그대로 쓴다 — notification_dismissals 와 같은 판단이다.
     */
    uniqueIndex("notification_kind_purposes_unique").on(table.clientId, table.kind),
  ]
);
