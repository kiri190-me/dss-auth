import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * ============================================================================
 * 결재 알림 메일을 **누구에게 · 어느 건으로** 보냈는가
 * ============================================================================
 * 이 표가 있는 이유는 하나다 — **같은 결재를 두 번 보내지 않기 위해서.** 작업은
 * 매일 돌고, 결재는 누가 처리하기 전까지 며칠씩 남아 있다. 기록이 없으면 그
 * 며칠 동안 같은 메일이 매일 간다(계측기 교정 알림이 `web_notifications` 에
 * 성공 기록을 남겨 건너뛰는 것과 같은 장치 — dss-deploy/nas/jobs/notify-daily.sh).
 *
 * ── 🔴 열쇠는 **(받는 사람, 시스템, 결재건 id)** 다. `kind` 가 아니다 ────────
 * 한 사람에게 **같은 갈래가 여러 건** 올 수 있다(견적서 결재 세 건). 갈래로
 * 열쇠를 삼으면 첫 건을 보낸 뒤 나머지 두 건이 영영 안 나간다 — 그리고 그
 * 사고는 오류를 내지 않는다. 아래 `kind` 칸은 **열쇠가 아니라 진단용**이다.
 *
 * ── 🔴 실패도 남긴다 ──────────────────────────────────────────────────────
 * `status` 가 `SENT` 인 줄만 「보냈다」로 센다(queries/approval-mail-deliveries.ts).
 * 실패한 줄은 남아 있되 다음 번에 **다시 보낸다** — 실패를 아예 안 적으면
 * 「보내려다 못 보냈다」와 「애초에 보낼 것이 없었다」가 구별되지 않아, 메일이
 * 안 온다는 신고가 들어왔을 때 볼 것이 아무것도 없다.
 *
 * ── 🔴 이 표의 행을 지우면 그 메일이 **다시 나간다** ──────────────────────
 * 보관 기간을 두지 않은 까닭이다. 「오래된 줄을 걷어 간다」는 이 표에서
 * 「오래 밀린 결재의 알림을 다시 보낸다」와 같은 말이 된다. 정말로 걷으려면
 * **그 결재가 끝났는지**를 알아야 하는데, 포털은 그것을 모른다 — 결재의 주인은
 * 각 시스템이고 포털은 「지금 남아 있는 것」만 물어볼 수 있다.
 * 🔵 대신 양이 걱정될 자리는 아니다. 한 줄은 (사람 × 결재건) 하나이고, 사내
 * 인원과 하루 결재 건수를 생각하면 1년에 수천 줄이다.
 *
 * 🔵 **알림을 저장하는 표가 아니다.** 여기 쌓이는 것은 열쇠 글자와 보낸 때뿐이고,
 * 결재의 내용(고객사·금액·품명·인수번호)은 **한 글자도 들어오지 않는다** —
 * 메일 본문에 싣지 않는 것과 같은 규칙이다(approvals/mail-message.ts).
 */
export const approvalMailDeliveries = pgTable(
  "approval_mail_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * 받은 사람(포털 `users.id`).
     *
     * 🔴 **`cascade` 다.** 포털의 외래키 대부분은 `restrict` 지만(감사 로그·권한
     * 부여·세션처럼 남아야 할 기록), 이 표는 `notification_dismissals` 와 같은
     * 쪽이다 — **보낼지 말지를 정하기 위한 운영 기록**이라, 사람이 지워지면
     * 그 사람 몫 기록은 쓸 데가 없고 그것이 계정 삭제를 막아 서면 곤란하다.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 어느 시스템의 결재인가. `clients.client_id` 와 같은 글자(외래키는 없다). */
    clientId: text("client_id").notNull(),
    /**
     * 그 시스템 안에서 이 결재건을 가리키는 값 — 저쪽이 보낸 `items[].id` 그대로다.
     *
     * 🔵 **다시 물어도 같은 값**이라는 것이 이 표의 전제다. 세 시스템 모두
     * (건, 갈래) 또는 (신청) 하나에 열쇠 하나를 쓰고, 반려 뒤 다시 올려도 같은
     * 열쇠가 나온다(A/S portal-approvals.ts 의 그 주석). 열쇠가 매번 달라지는
     * 시스템이 생기면 그 시스템은 **같은 메일을 날마다 보내게 된다.**
     *
     * 🔵 길이 상한을 두지 않은 까닭은 `notification_dismissals.notification_key`
     * 와 같다 — 저쪽이 id 모양을 바꾸는 날 기록만 조용히 실패하면 안 된다.
     */
    itemId: text("item_id").notNull(),
    /**
     * 갈래 코드. 🔴 **열쇠가 아니다 — 진단용이다.**
     *
     * 「휴가 결재 메일이 나가기는 했나」를 이 칸 하나로 센다. 없어도 동작은
     * 같지만, 없으면 그 물음에 답하려고 각 시스템에 되물어야 한다.
     */
    kind: text("kind").notNull(),
    /**
     * `SENT`(보냈다) 또는 `FAILED`(보내려다 실패).
     *
     * 🔴 **CHECK 도 pgEnum 도 걸지 않았다** — `notification_kind_purposes.purpose`
     * 와 같은 판단이다. 값을 늘릴 때 마이그레이션이 깨지고, 제약이 없어도
     * 사고가 나지 않는다: 읽는 쪽이 **`SENT` 인 줄만** 「보냈다」로 세므로,
     * 모르는 글자는 「아직 안 보냈다」쪽으로 떨어진다. 그쪽이 안전하다 —
     * 메일이 한 번 더 갈 뿐, 놓치지는 않는다.
     */
    status: text("status").notNull(),
    /**
     * 실패했을 때 그 까닭(SMTP 가 돌려준 말). 성공이면 null.
     *
     * 🔴 **결재 내용은 여기 들어오지 않는다.** 담기는 것은 메일 서버가 돌려준
     * 문구뿐이고, 그 문구는 쓰는 쪽에서 길이를 잘라 넣는다(lib/mail/send.ts).
     */
    error: text("error"),
    /** 보낸(또는 보내려 한) 때. */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * 🔴 **두 번 보내지 않기**를 DB 가 지키는 자리.
     *
     * 쓰는 쪽은 이 제약에 기대어 upsert 한다 — 지난번에 실패(`FAILED`)한 줄이
     * 있으면 그 줄을 `SENT` 로 덮는다(mutations/approval-mail-deliveries.ts).
     *
     * 🔵 `(user_id)` 단독 색인은 두지 않았다. 「이 사람에게 이미 보낸 것」을
     * 찾는 조회가 이 색인의 왼쪽 앞부분을 그대로 쓴다 —
     * `notification_dismissals` 와 같은 판단이다.
     */
    uniqueIndex("approval_mail_deliveries_unique").on(
      table.userId,
      table.clientId,
      table.itemId
    ),
    /**
     * 「어제 메일이 몇 통 나갔나」를 날짜로 훑는 색인.
     *
     * 🔵 위 유일 색인은 `user_id` 로 시작하므로 **시각만으로 찾는 조회에는 쓸 수
     * 없다.** 사람이 신고를 들고 왔을 때 보는 것이 늘 「그 무렵에 무엇이
     * 나갔나」라서 하나 더 둔다. 이 표는 쓰기가 하루 한 번뿐이라 색인 하나를
     * 더 갱신하는 값이 사실상 없다.
     */
    index("approval_mail_deliveries_sent_at_idx").on(table.sentAt),
  ]
);
