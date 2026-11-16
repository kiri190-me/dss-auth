import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * ============================================================================
 * 결재권 위임 — 사내 **모든** 시스템에 한 번에 걸린다
 * ============================================================================
 * 결재가 있는 시스템은 셋이다(A/S · 재고관리 · 휴가). 자리를 비우는 사람이 제
 * 결재권을 남에게 맡기는 기능은 그중 둘에 **서로 다른 모양으로** 따로 있었고,
 * 휴가에는 아예 없었다. 이 표는 그 셋이 함께 보는 **한 자리**다.
 *
 * ── 🔴 왜 포털인가 — 사람을 가리키는 열쇠가 여기 하나뿐이라서 ──────────────
 * 시스템마다 사람을 다른 값으로 가리킨다:
 *
 *   · 포털(여기)  `users.id`(uuid). 🔴 **이 값이 그대로 ID 토큰의 `sub`** 가 되어
 *                 각 시스템에 전달된다(users.ts 의 그 줄). 한 번 발급되면 안 바꾼다
 *   · A/S         **제 안의 `users.id`**(uuid). 포털 번호는 `users.sso_subject` 에
 *                 따로 들고 있다 — 그래서 포털이 준 값을 **한 번 바꿔야** 쓴다
 *   · 재고관리    포털 `sub`(text, FK 없음) — 바꿀 것이 없다
 *   · 통합 승인함 포털 `sub` 하나뿐
 *
 * 🔴 그 둘을 섞어 **2026-10-15 에 실제 장애가 났다**(재고관리 주석): 「내가 결재할
 * 건」이 영원히 빈 목록이 되는, **코드는 맞고 값만 안 맞는** 결함. 오류가 한 줄도
 * 안 나므로 신고가 들어오기 전에는 아무도 모른다.
 *
 * 🔵 **공통 열쇠는 포털 `sub` 하나뿐**이라, 위임을 포털에 두면 그 문제가 저절로
 * 풀린다 — 여기서는 `users.id` 가 곧 `sub` 라 **바꿀 것이 없다**. 바꿔야 하는 쪽은
 * 받아 가는 A/S 이고, 그 변환은 저쪽 일이다(설계 C-3).
 *
 * 🔴 **A/S 표(`approval_route_delegations`)의 머리말을 베껴 오지 마라.** 저쪽은
 * 「열쇠는 `users.id` 다. 포털 번호가 아니다」라고 못 박고 있는데, 그 말은 **저쪽
 * 저장소에서만** 참이다. 여기서는 정반대로 **포털 `users.id` = 포털 번호**다.
 *
 * ── 🔴 `scope` 칸을 두지 않는다 (2026-11-16 사용자 결정) ───────────────────
 * 「어느 시스템 / 어느 결재 갈래에 적용되는가」를 적는 칸이 **없다.** 여기 한 줄을
 * 넣으면 A/S·재고관리·휴가의 **모든 결재 갈래**에 걸린다.
 *
 * 까닭: 사용자가 요청한 것이 「여기서 위임하면 **다른 모든 서비스에서도 동일하게**
 * 위임」이다. 칸을 두면 첫 화면부터 「어디에 걸까」를 매번 골라야 하고, 고르는 자리가
 * 늘면 **안 고른 시스템에서만 조용히 안 듣는** 모양이 생긴다 — 이 기능에서 가장
 * 비싼 결함이 그것이다(결재가 멈춰도 아무 오류가 안 난다).
 *
 * 🔵 나중에 「A/S 것만 맡긴다」가 필요해지면 **그때 칸을 더한다.** 더할 때 걸리는
 * 것을 미리 적어 둔다: 갈래 이름의 주인이 `src/lib/approvals/kinds.ts` 에 **코드로
 * 박혀** 있고 자동으로 맞춰지지 않는다(설계 D-4). 칸을 더하는 날 그 이름 체계와
 * 맞춰야 하고, **기존 줄은 전부 「전부 적용」으로 읽혀야 한다**(널 = 한정 없음).
 *
 * ── 🔴 각 시스템의 제 위임도 그대로 살아 있다 (설계 B-4) ──────────────────
 * A/S 의 `approval_route_delegations` · 재고관리의 `approval_delegations` 를 걷어내지
 * 않는다. 판정은 **합집합**이 된다 — 한쪽에만 지정된 사람도 누를 수 있다. 🔵 해롭지는
 * 않지만(둘 다 대신할 수 있을 뿐이다) **되돌릴 때 「어디에 지정했나」를 사람이 알아야
 * 한다.** 화면이 그 출처를 구별해 보여 주는 것이 조각 2·3 의 숙제다.
 *
 * ── 겹치는 기간을 DB 로 막지 않는다 ─────────────────────────────────────
 * 같은 사람에게 기간이 겹치는 위임이 여럿 있어도 **정상이다.** 두 사람이 동시에
 * 자리를 비울 수도 있고, 한 사람에게 기간을 나눠 두 번 맡길 수도 있다. 겹침을 EXCLUDE
 * 제약으로 막으려면 btree_gist 확장이 필요한데 이 규모에서 얻을 것이 없다. 대신
 * **판정 함수가 중복을 걸러 낸다**(lib/approvals/delegation.ts) — 겹친 줄이 둘이어도
 * 결재권자 번호는 한 번만 돌아온다.
 *
 * ── 줄은 지우지 않는다 ──────────────────────────────────────────────────
 * 되돌리기는 `revoked_at` 에 시각을 적는 것이다. 「만료」는 저장하지 않는다 — 기간이
 * 지났는지는 언제나 읽을 때 지금과 견주어 계산한다. 저장해 두면 언젠가 자료가 낡는다.
 *
 * 🔵 **이름이 같은 표가 재고관리에도 있다**(`approval_delegations`). 다른 DB 의 다른
 * 표이고 열쇠 모양만 우연히 같다 — 한쪽을 고치며 다른 쪽을 함께 고쳤다고 믿지 말 것.
 * ============================================================================
 */
export const approvalDelegations = pgTable(
  "approval_delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * 결재권을 **맡기는** 사람의 포털 `users.id`(= 그 사람의 `sub`).
     *
     * 🔴 **FK 가 있다.** 포털이 사람 명부의 **주인**이라 걸 수 있고, 걸어 두면 없는
     * 사람 번호가 들어간 줄이 아예 안 생긴다. 재고관리가 같은 뜻의 칸에 FK 를 못 거는
     * 것은 남의 시스템 사람을 가리키기 때문이지 그 모양이 더 나아서가 아니다.
     *
     * 🔴 `restrict` 다 — **이 저장소의 관례를 따른다.** 포털의 외래키는 두 갈래다:
     * 감사 로그·권한 부여·세션·토큰처럼 **남아 있어야 할 기록**은 `restrict`(딸린 것이
     * 있으면 사람 삭제를 막아 선다), 알림 지움·승인함 열람처럼 **하루면 사라지는 임시
     * 표시**는 `cascade`. 위임은 「누가 누구의 결재권을 언제부터 언제까지 가졌나」라는
     * **근거**라서 앞쪽이다. 🔵 포털에는 지금 사람 행을 지우는 코드가 **아예 없어서**
     * 당장 달라지는 것은 없다 — 그래도 적어 두는 까닭은 다음 사람이 이웃 표(`cascade`)만
     * 보고 「통일성」을 이유로 바꾸지 않게 하기 위해서다.
     */
    delegatorUserId: uuid("delegator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** 대신 눌러 줄 사람의 포털 `users.id`. 🔴 위와 같은 까닭으로 FK · `restrict` 다. */
    delegateUserId: uuid("delegate_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    /**
     * 🔴 **이 순간은 포함하지 않는다**(반열린 구간 `[starts_at, ends_at)`). 「11월
     * 30일까지」를 적을 때 여기 들어가는 값은 **12월 1일 0시**다. 까닭은 판정 함수
     * 주석에 있다 — 잇대어 적은 두 위임이 한순간 둘 다 살아 있는 일을 막는다.
     */
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /**
     * 사유. 선택 입력이라 **널 대신 빈 글자**다 — 「안 적었다」와 「모른다」를 가를
     * 일이 없는 칸이라, 읽는 쪽마다 `?? ""` 를 적게 만들지 않는다.
     */
    reason: text("reason").notNull().default(""),
    /**
     * 이 줄을 **만든** 사람. 본인이 스스로 맡긴 것인지 포털 관리자가 대신 세운 것인지가
     * 여기 남는다 — `delegator_user_id` 와 같으면 본인, 다르면 남이 세운 것이다.
     */
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * 되돌린 시각. 아직 살아 있으면 `NULL`.
     *
     * 🔴 **기간을 줄여 적는 것이 아니다.** 되돌려도 `ends_at` 은 그대로 남으므로,
     * 기간만 보고 판정하면 되돌린 뒤에도 계속 참이 된다. 판정 함수가 이 칸을 **먼저**
     * 보는 까닭이 그것이다.
     *
     * 🔴 아래 `revoked_by_user_id` 와 **짝이다** — 둘 다 적히거나 둘 다 비어 있다
     * (아래 `…_revocation_metadata` CHECK).
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** 되돌린 사람. 🔴 위 `revoked_at` 과 짝이라 혼자 적힐 수 없다(아래 CHECK). */
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
  },
  (table) => [
    // 「내가 지금 누구를 대신하나」 — 🔴 **각 시스템이 결재 때마다 묻는 그 조회**다
    // (api/integration/delegations 의 `acting`). 대리인으로 좁히고(`delegate_user_id`),
    // 되돌리지 않은 줄만 남기고(`revoked_at IS NULL`), 아직 안 끝난 것만 본다
    // (`ends_at > now()`). 칸 순서가 그 순서다.
    //
    // 🔵 `starts_at` 은 일부러 넣지 않았다 — 한 사람에게 걸린 위임은 많아야 몇 줄이라
    // 앞 셋으로 좁히고 나면 시작 시각은 읽은 뒤 걸러도 된다. 넣어 봐야 색인만 굵어진다.
    //
    // 🔵 반대 방향(「나를 누가 대신하나」)에는 색인이 없다. 그 조회는 화면을 그릴 때만
    // 돌고 표가 「지금 자리를 비운 사람 수」만큼만 자라므로, 느려진 뒤에 **재어 보고**
    // 더한다.
    index("approval_delegations_delegate_active_idx").on(
      table.delegateUserId,
      table.revokedAt,
      table.endsAt
    ),
    // 끝이 시작보다 뒤여야 한다. 같아도 안 된다 — 끝을 포함하지 않으므로 `ends_at =
    // starts_at` 인 줄은 **단 한순간도 살아 있지 않은** 위임이 되고, 그런 줄은 만든
    // 사람이 「맡겨 뒀다」고 믿는데 아무 일도 일어나지 않는 가장 나쁜 모양이다.
    check("approval_delegations_valid_range", sql`ends_at > starts_at`),
    // 「A 가 A 를 대신한다」는 뜻이 없는 줄이다. 본인은 판정 함수가 언제나 목록
    // 맨 앞에 넣어 주므로(actingApproverSubjects), 이런 줄은 아무것도 늘리지 않는다.
    check("approval_delegations_different_users", sql`delegate_user_id <> delegator_user_id`),
    // 🔴 되돌림 두 칸은 **함께 적히거나 함께 비어 있다.** 판정 함수는 `revoked_at`
    // **한 칸만** 본다(lib/approvals/delegation.ts). 그래서 `revoked_by_user_id` 만
    // 적히고 시각이 빈 줄이 들어오면 **되돌렸는데 계속 살아 있는 위임**이 된다 —
    // 오류도 경고도 나지 않고, 맡긴 사람이 「되돌렸다」고 믿는 동안 대리인이 계속
    // 누를 수 있다. 읽는 쪽마다 「둘이 어긋난 줄」을 처리하게 하는 대신 **DB 가 그런
    // 줄을 아예 못 만들게** 한다 — 한 자리에서 끝난다.
    // 🔵 CHECK 를 걷어내는 날이 오면 **판정 함수부터 다시 보라.**
    check(
      "approval_delegations_revocation_metadata",
      sql`
        (revoked_at IS NULL AND revoked_by_user_id IS NULL)
        OR
        (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL)
      `
    ),
  ]
);
