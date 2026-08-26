import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { identityProviderEnum } from "./identities";
import { users } from "./users";

/**
 * dss-auth의 브라우저 세션.
 *
 * A/S 시스템의 dss_session 쿠키(서명만으로 성립하는 stateless 토큰)와 달리
 * **서버 저장형**이다. 이유가 분명하다 — SSO의 값어치 절반은 "한 곳에서
 * 끊으면 전부 끊긴다"인데, stateless 토큰은 발급한 뒤 회수할 방법이 없다.
 * 퇴사자를 즉시 차단하려면 서버에 세션 실체가 있어야 한다.
 *
 * 쿠키에는 32바이트 랜덤만 담고, DB에는 그 sha256만 저장한다. DB 덤프가
 * 새더라도 살아 있는 세션을 그대로 탈취당하지 않기 위해서다.
 */
export const ssoSessions = pgTable(
  "sso_sessions",
  {
    // 이 값이 ID 토큰의 sid 클레임으로 나간다. 지금은 쓰지 않지만 넣어 두면
    // 나중에 백채널 로그아웃을 붙일 때 스키마 변경이 필요 없다.
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    authMethod: identityProviderEnum("auth_method").notNull(),
    authTime: timestamp("auth_time", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // 절대 만료. 활동이 있어도 이 시점이 지나면 다시 로그인해야 한다.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    sourceIp: text("source_ip"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sso_sessions_token_hash_unique").on(table.tokenHash),
    index("sso_sessions_user_id_idx").on(table.userId),
  ]
);
