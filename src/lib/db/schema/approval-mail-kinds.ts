import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * ============================================================================
 * 어느 **결재 갈래**에 메일을 보낼 것인가 — 관리자가 켜고 끄는 다섯 개의 스위치
 * ============================================================================
 * 새 결재 요청이 생기면 그 결재를 해야 할 사람에게 메일이 간다. 그 메일을
 * 갈래별로 켜고 끄는 값이 여기 쌓인다.
 *
 * 🔴 **기본값은 「전부 끔」이다**(2026-10-23 결정). 행이 아예 없는 갈래는 꺼진
 * 것으로 읽는다(approvals/kinds.ts 의 `isApprovalMailKindEnabled`). 켜는 것은
 * 사람이 하는 일이다 — 기본이 켜짐이면 표를 만들자마자 전 직원에게 메일이
 * 쏟아지고, 그때는 되돌릴 방법이 없다(이미 나간 메일은 회수할 수 없다).
 *
 * 🔵 그래서 이 표는 **「켬」을 적어 두는 표**에 가깝다. `enabled=false` 행도
 * 생기는데(켰다가 다시 끈 경우), 그것은 「없음」과 뜻이 같다 — 다만 누가 언제
 * 껐는지가 남는다.
 *
 * ── 🔴 열쇠가 왜 `(client_id, kind)` 인가 ──────────────────────────────────
 * 갈래 코드 다섯(`REPAIR_INSPECTION`·`FINAL_SHIPMENT`·`QUOTE_APPROVAL`·
 * `PART_ISSUE_APPROVAL`·`LEAVE_REQUEST`)은 지금 세 시스템에 걸쳐 서로 겹치지
 * 않으므로 `kind` 하나로도 가를 수 있다. 그래도 시스템을 함께 적는 까닭은,
 * 겹치는 날 **두 시스템의 스위치가 한 개로 뭉쳐 버리기** 때문이다. 그 사고는
 * 오류를 내지 않는다 — 한쪽을 끄면 다른 쪽 메일도 조용히 멎는다.
 * `notification_kind_purposes` 가 같은 열쇠를 쓰는 것과도 모양이 맞는다.
 *
 * 🔴 **`clients` 에 외래키를 걸지 않았다.** `notification_kind_purposes` 와 같은
 * 까닭이다: 통로를 가진 시스템 목록을 정하는 것은 `clients` 표가 아니라 포털
 * 코드의 상수이고(approvals/kinds.ts · approvals/sources.ts), 외래키를 걸면 그
 * 둘이 어긋나는 날 **설정이 조용히 사라진다.**
 */
export const approvalMailKinds = pgTable(
  "approval_mail_kinds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `clients.client_id` 와 같은 글자. 🔴 외래키는 없다(위 머리말). */
    clientId: text("client_id").notNull(),
    /**
     * 결재 갈래 코드. 저쪽이 `/api/integration/approvals` 로 보내는 `kind` 글자
     * 그대로다.
     *
     * 🔵 길이 상한을 두지 않은 까닭은 `notification_kind_purposes.kind` 와 같다 —
     * varchar 로 자릿수를 박으면 저쪽이 코드 모양을 바꾸는 날 **설정 저장만
     * 조용히 실패**한다.
     */
    kind: text("kind").notNull(),
    /**
     * 이 갈래에 메일을 보낼 것인가.
     *
     * 🔴 **칸의 기본값도 `false` 다.** 행을 손으로 넣는 사람이 이 칸을 빠뜨려도
     * 켜지지 않게 한다 — 이 값의 기본은 코드와 DB 양쪽에서 같은 쪽(끔)을 봐야
     * 한다.
     */
    enabled: boolean("enabled").notNull().default(false),
    /**
     * 마지막으로 이 스위치를 만진 사람.
     *
     * 🔴 `set null` 이다 — `notification_kind_purposes.updated_by` 와 같은 판단.
     * 설정은 조직의 규칙이라 사람이 지워져도 **값은 남아야 하고**(cascade 면
     * 그 사람이 켜 둔 갈래가 통째로 꺼진다), 스위치 한 줄이 계정 삭제를 막아
     * 서도 곤란하다(restrict).
     */
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** 언제 만졌는가. 🔵 보관 기간이 없다 — 설정은 걷어 가는 자료가 아니다. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * 한 시스템의 한 갈래에 스위치는 하나뿐이다. 쓰는 쪽이 이 제약에 기대어
     * 「있으면 고치고 없으면 넣는다」로 간다(mutations/approval-mail-kinds.ts).
     *
     * 🔵 `client_id` 단독 색인은 두지 않았다. 이 색인이 `(client_id, kind)`
     * 순서라 한 시스템치를 통째로 읽는 조회도 왼쪽 앞부분 규칙으로 그대로 쓴다 —
     * `notification_kind_purposes` 와 같은 판단이다. 게다가 이 표는 **다섯 줄**
     * 짜리라 어느 쪽이든 색인을 탈 일조차 드물다.
     */
    uniqueIndex("approval_mail_kinds_unique").on(table.clientId, table.kind),
  ]
);
