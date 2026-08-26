import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * 외부 신원 ↔ 사내 사원 매핑.
 *
 * users에서 분리한 이유:
 *  1. 한 사람이 카카오와 비상계정을 동시에 가질 수 있어야 한다.
 *  2. 나중에 Synology NAS의 LDAP을 붙일 때 provider에 값 하나 늘리는 것으로
 *     끝나야 한다 — users 테이블을 다시 마이그레이션하지 않도록.
 *
 * LDAP은 지금 쓰지 않지만 enum에 미리 넣어 둔다. enum 값 추가는 나중에도
 * 가능하지만, 지금 넣어 두면 그때 마이그레이션이 아예 필요 없다.
 */
export const identityProviderEnum = pgEnum("identity_provider", [
  "KAKAO",
  "EMERGENCY",
  "LDAP",
]);

export const identities = pgTable(
  "identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    provider: identityProviderEnum("provider").notNull(),
    // KAKAO: 카카오 회원번호(카카오가 주는 sub)
    // EMERGENCY: 로그인 아이디
    // LDAP: DN 또는 uid
    //
    // ⚠️ 카카오의 sub는 pairwise다 — 카카오 앱마다 다른 값이 나온다.
    // 카카오 개발자 콘솔에서 앱을 지우고 다시 만들면 전 직원의 이 값이
    // 바뀌어 전원 재연결이 필요하다. 앱을 절대 삭제하지 말 것.
    providerSubject: text("provider_subject").notNull(),
    // EMERGENCY 전용. node:crypto 내장 scrypt를 쓴다 — bcrypt/argon2는
    // 네이티브 빌드가 필요해 NAS Docker 이미지 빌드를 복잡하게 만든다.
    // 형식: "scrypt$N$r$p$<saltB64>$<hashB64>"
    passwordHash: text("password_hash"),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 같은 제공자 안에서 같은 식별자가 두 사람에게 붙을 수 없다.
    uniqueIndex("identities_provider_subject_unique").on(
      table.provider,
      table.providerSubject
    ),
    index("identities_user_id_idx").on(table.userId),
  ]
);
