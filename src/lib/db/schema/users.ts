import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * 사내 사원 명단.
 *
 * **역할(role)과 권한은 여기에 두지 않는다.** 각 시스템이 자기 DB에서 관리하고
 * users.id로만 이어 붙인다. dss-auth가 답하는 질문은 딱 하나다 —
 * "이 사람이 우리 회사 사람이고, 지금 쓸 수 있는 상태인가."
 *
 * 로그인 수단(카카오 회원번호 등)도 여기 두지 않는다. identities 테이블로
 * 분리했다 — 한 사람이 카카오와 비상계정을 동시에 가질 수 있어야 하고,
 * 나중에 Synology LDAP을 붙일 때 스키마 변경 없이 값만 늘리면 되기 때문이다.
 */
export const userStatusEnum = pgEnum("user_status", [
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
]);

export const users = pgTable(
  "users",
  {
    // 이 값이 그대로 ID 토큰의 sub가 되어 각 시스템에 전달된다.
    // 한 번 발급되면 절대 바꾸지 않는다 — 바꾸면 전 시스템에서 다른 사람이 된다.
    id: uuid("id").primaryKey().defaultRandom(),
    // 카카오 닉네임이 최초값으로 들어오고, 관리자가 승인하면서 실명으로 고친다.
    // 카카오 닉네임("길동이")을 그대로 사내 시스템 이름으로 쓸 수는 없다.
    displayName: text("display_name").notNull(),
    // 카카오에서 이메일은 선택 동의라 안 올 수 있다. 그래서 nullable이고,
    // **신원 판별 기준으로 쓰지 않는다** — 사용자가 바꿀 수 있는 값이다.
    email: text("email"),
    employeeNo: text("employee_no"),
    department: text("department"),
    status: userStatusEnum("status").notNull().default("PENDING"),
    // 포털 자체(사용자 승인, 클라이언트 등록)를 관리할 수 있는가.
    // 각 시스템 내부의 관리자 권한과는 무관하다.
    isPortalAdmin: boolean("is_portal_admin").notNull().default(false),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references((): AnyPgColumn => users.id, {
      onDelete: "restrict",
    }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendReason: text("suspend_reason"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 부분 유니크 — 이메일이 없는(null) 행끼리는 서로 충돌하지 않는다.
    uniqueIndex("users_email_unique")
      .on(table.email)
      .where(sql`email is not null`),
    index("users_status_idx").on(table.status),
  ]
);
