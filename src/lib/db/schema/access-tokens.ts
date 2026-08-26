import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./clients";
import { users } from "./users";

/**
 * 액세스 토큰은 **불투명(opaque) 랜덤 문자열**로 발급한다. JWT로 만들지 않는다.
 *
 * 이 토큰을 검사하는 리소스 서버가 dss-auth 자신(/userinfo)뿐이기 때문이다.
 * JWT로 만들면 "서버에 묻지 않고 검증 가능"이라는 이점을 얻는데, 받는 쪽이
 * 어차피 우리 자신이라 그 이점이 0이다. 대신 "발급한 토큰을 즉시 폐기할 수
 * 없다"는 대가만 치르게 된다.
 *
 * ID 토큰은 반대다 — 각 시스템이 우리에게 묻지 않고 검증해야 하므로 JWT(RS256).
 */
export const accessTokens = pgTable("access_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "restrict" }),
  scope: text("scope").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // 인가 코드 재사용이 탐지되면 그 코드로 발급된 토큰을 여기서 즉시 죽인다.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
