import { pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
