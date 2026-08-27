import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * 연결된 사내 시스템 = OIDC 클라이언트.
 *
 * 동적 등록(Dynamic Client Registration)은 구현하지 않는다. 시스템 개수가
 * 한 자릿수이고, 등록 자체가 보안 결정이라 사람이 승인하는 편이 맞다.
 */
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 각 시스템이 인가 요청에 실어 보내는 공개 식별자. 예: "rf-service-system"
    clientId: text("client_id").notNull(),
    name: text("name").notNull(), // "DSS A/S 관리 시스템"
    description: text("description"),
    // 평문 저장 금지. sha256 hex만 남긴다. 발급 시 콘솔에 딱 한 번 보여주고
    // 잃어버리면 재발급만 가능하다 — 복구는 원리상 불가능하다.
    clientSecretHash: text("client_secret_hash").notNull(),
    clientSecretRotatedAt: timestamp("client_secret_rotated_at", {
      withTimezone: true,
    }),
    // ⚠️ 정확 일치(exact string match)로만 검증한다. 와일드카드도, 접두사
    // 일치도, 정규화도 하지 않는다. 정규화를 시작하면 등록값과 요청값의
    // 정규화 결과가 우연히 겹치는 우회 경로가 생긴다.
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * 세션이 끊겼을 때 알려 줄 주소(OIDC 백채널 로그아웃).
     *
     * 비어 있으면 알리지 않는다 — 통보를 받을 준비가 안 된 시스템에 계속
     * 실패하는 요청을 보내면 로그만 지저분해진다. 붙일 준비가 된 시스템이
     * 스스로 등록하는 구조다.
     *
     * ⚠️ 이 주소로는 서명된 토큰만 보낸다. 받는 쪽은 반드시 서명·iss·aud를
     * 확인해야 한다 — 확인 없이 받으면 누구나 아무나를 로그아웃시킬 수 있는
     * 창구가 된다.
     */
    backchannelLogoutUri: text("backchannel_logout_uri"),
    // true면 user_client_grants에 행이 있어야 이 시스템에 들어갈 수 있다.
    requiresGrant: boolean("requires_grant").notNull().default(true),
    /**
     * 이 시스템이 쓰는 역할 목록. 포털 관리 화면이 드롭다운을 그릴 때만 쓴다.
     *
     * 포털에 역할 칸을 하나 두지 않고 시스템마다 목록을 갖게 한 이유:
     * 역할은 시스템의 것이지 회사의 것이 아니다. A/S의 AS_ENGINEER는 다음에
     * 붙을 팀의 시스템에서는 아무 의미가 없다. 포털이 특정 시스템의 역할
     * 목록을 아는 순간 그 시스템 전용 코드가 포털에 스며든다.
     *
     * 비어 있으면 그 시스템은 역할을 쓰지 않는다는 뜻이고, 관리 화면은
     * "권한 있음/없음"만 묻는다.
     *
     * ⚠️ 여기 적힌 값이 유효한지는 포털이 판단하지 않는다. 받는 시스템이
     * 자기 목록과 대조해 모르는 값이면 거절해야 한다 — 포털의 오타가 그쪽
     * 권한 모델을 흔들면 안 된다.
     */
    availableRoles: text("available_roles")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isActive: boolean("is_active").notNull().default(true),
    // 포털 앱 런처(/apps) 타일 표시용
    launcherUrl: text("launcher_url"),
    launcherIcon: text("launcher_icon"),
    sortOrder: integer("sort_order").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("clients_client_id_unique").on(table.clientId)]
);
