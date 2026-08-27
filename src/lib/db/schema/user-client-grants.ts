import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { clients } from "./clients";
import { users } from "./users";

/**
 * 누가 어느 시스템에 들어갈 수 있는가.
 *
 * "우리 회사 사람인가"(users.status)와 "이 시스템을 쓸 사람인가"는 다른
 * 질문이다. 영업팀 직원이 회사 사람인 것과 A/S 관리 시스템을 써야 하는 것은
 * 별개다.
 */
export const userClientGrants = pgTable(
  "user_client_grants",
  {
    // 감사 로그가 target_record_id로 가리킬 수 있도록 대리 키를 둔다.
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    /**
     * 이 사람이 저 시스템에서 갖는 역할. ID 토큰의 role 클레임으로 나간다.
     *
     * 사용자가 아니라 부여 행에 붙는다 — 한 사람이 시스템마다 다른 역할일
     * 수 있고(A/S에서는 영업, 다음 시스템에서는 관리자), 역할 목록 자체가
     * 시스템마다 다르기 때문이다.
     *
     * nullable이다. 역할을 쓰지 않는 시스템도 있고, 역할 개념이 생기기 전에
     * 만들어진 부여 행도 있다. null이면 role 클레임을 아예 싣지 않는다 —
     * 받는 쪽에서 "클레임이 없다"와 "빈 역할이다"는 다르게 다뤄야 한다.
     */
    role: text("role"),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("user_client_grants_unique").on(table.userId, table.clientId),
  ]
);
