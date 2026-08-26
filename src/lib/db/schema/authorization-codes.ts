import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./clients";
import { ssoSessions } from "./sso-sessions";
import { users } from "./users";

/**
 * 인가 코드 — 수명 60초, 1회성.
 *
 * 평문은 DB에 남기지 않는다(기본키가 sha256 해시다). DB 덤프가 새면 아직
 * 살아 있는 코드를 그대로 토큰으로 바꿀 수 있게 되기 때문이다.
 *
 * consumedAt은 행을 지우는 대신 표시로 둔다. 재사용 시도를 탐지하려면
 * "이미 쓴 코드"라는 흔적이 남아 있어야 한다 — 지워버리면 재사용 공격과
 * 단순 오타를 구분할 수 없다.
 */
export const authorizationCodes = pgTable(
  "authorization_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ssoSessionId: uuid("sso_session_id")
      .notNull()
      .references(() => ssoSessions.id, { onDelete: "restrict" }),
    // authorize 때 받은 값을 그대로 보관해 두었다가, token 요청에 실려 온
    // 값과 **문자열 정확 일치**로 비교한다. 정규화하지 않는다.
    redirectUri: text("redirect_uri").notNull(),
    scope: text("scope").notNull(),
    // 필수로 강제한다. 없으면 authorize 단계에서 거절한다.
    nonce: text("nonce").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    // "S256"만 허용한다. "plain"은 PKCE를 무의미하게 만든다.
    codeChallengeMethod: text("code_challenge_method").notNull(),
    authTime: timestamp("auth_time", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("authorization_codes_expires_at_idx").on(table.expiresAt),
  ]
);
