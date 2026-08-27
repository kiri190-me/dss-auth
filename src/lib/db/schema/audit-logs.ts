import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * 감사 로그. RF_Service_System의 audit_logs와 같은 폴리모픽 append-only
 * 구조를 따른다 — 행을 수정하거나 지우지 않는다. 보관 3년.
 */
export const authAuditActionEnum = pgEnum("auth_audit_action", [
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGOUT",
  "SESSION_REVOKED",
  "USER_CREATED",
  "USER_APPROVED",
  "USER_SUSPENDED",
  "USER_UPDATED",
  "CLIENT_CREATED",
  "CLIENT_UPDATED",
  "CLIENT_SECRET_ROTATED",
  "GRANT_ADDED",
  "GRANT_REMOVED",
  // 접근 권한은 그대로 두고 역할만 바꾼 경우. GRANT_ADDED로 뭉뚱그리지 않는
  // 이유: 역할은 받는 시스템의 권한을 그대로 정한다(A/S는 이 값으로
  // users.role을 덮어쓴다). 누가 누구를 언제 최고관리자로 올렸는지가
  // "권한을 줬다"와 같은 줄에 섞이면 안 된다.
  "GRANT_ROLE_CHANGED",
  "TOKEN_ISSUED",
  // 인가 코드가 두 번 제시되었다 — 탈취 또는 구현 오류의 신호다.
  "CODE_REPLAY_DETECTED",
  "EMERGENCY_LOGIN",
  "KEY_ROTATED",
]);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // null이면 시스템이 스스로 한 일(로그인 시도 실패 등 행위자가 아직
    // 확정되지 않은 경우 포함).
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    actionType: authAuditActionEnum("action_type").notNull(),
    targetEntity: text("target_entity"),
    targetRecordId: uuid("target_record_id"),
    previousValue: jsonb("previous_value"),
    newValue: jsonb("new_value"),
    // OIDC client_id 문자열. clients 행이 지워져도 기록은 남아야 하므로
    // FK가 아니라 평문으로 둔다.
    clientId: text("client_id"),
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_logs_created_at_idx").on(table.createdAt),
    index("audit_logs_actor_user_id_idx").on(table.actorUserId),
    index("audit_logs_action_type_idx").on(table.actionType),
  ]
);
