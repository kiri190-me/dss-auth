import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvalMailDeliveries } from "@/lib/db/schema";
import {
  APPROVAL_DELIVERY_SENDING,
  APPROVAL_DELIVERY_SENT,
  APPROVAL_SENDING_LEASE_MS,
} from "@/lib/approvals/delivery-state";

/**
 * ============================================================================
 * 「이 건들은 **내가** 보낸다」를 먼저 찍는다 — 즉시 알림의 중복 방지 전부
 * ============================================================================
 * 즉시 알림은 **적고 나서 보낸다.** 까닭과 치르는 값은
 * approvals/delivery-state.ts 머리말에 있다. 이 파일은 그 「적기」다.
 *
 * ── 🔴 왜 조회 뒤에 쓰기로는 안 되는가 ────────────────────────────────────
 * 「이미 보냈나 물어보고, 안 보냈으면 보낸다」는 **동시에 둘이 들어오면 깨진다.**
 * 결재 둘이 1초 사이에 생기면 포털이 같은 사람에 대해 두 번 찔리고, 둘 다
 * 「아직 안 보냄」을 읽은 뒤 **둘 다 보낸다.** 조회와 쓰기 사이에 다른 요청이
 * 들어올 틈이 있는 한 어떤 순서로 짜도 그렇다.
 *
 * 🔵 그래서 **한 문장**으로 묻고 찍는다. 같은 열쇠에 `INSERT … ON CONFLICT` 가
 * 둘 들어오면 Postgres 가 뒤의 것을 앞의 것이 끝날 때까지 **세워 둔다.** 뒤의
 * 것이 깨어나 보는 값은 이미 `SENDING` 이라 아래 `setWhere` 가 거짓이 되고,
 * 그 줄은 `RETURNING` 에 **안 담긴다.** 담긴 것만 메일에 싣는다.
 *
 * ── 🔴 돌려받은 것만이 「내 것」이다 ──────────────────────────────────────
 * 부르는 쪽은 보낸 줄 수와 돌려받은 줄 수를 **견주면 안 된다** — 견주는 순간
 * 「덜 찍혔으니 실패」로 읽게 되는데, 사실은 **다른 요청이 이미 보내고 있다**는
 * 정상 상태다(approvals/notice-run.ts 의 `skippedLostRace`).
 * ============================================================================
 */

/** 찍을 줄 하나. 🔴 결재의 내용은 들어 있지 않다(열쇠와 갈래뿐). */
export type ApprovalDeliveryClaim = {
  clientId: string;
  itemId: string;
  kind: string;
};

/** 찍는 데 성공한 줄. 🔵 보낸 것 중 **일부**일 수 있다(머리말). */
export type ApprovalDeliveryClaimed = {
  clientId: string;
  itemId: string;
};

/**
 * 한 사람 몫의 결재건들에 「보내는 중」을 찍는다. 🔴 **찍힌 것만 돌려준다.**
 *
 * 세 경우가 갈린다:
 *  · 기록이 **없다** → 새 줄을 `SENDING` 으로 넣고 돌려준다. **내 것이다.**
 *  · 기록이 `FAILED` 거나 수명이 **지난** `SENDING` → 덮어쓰고 돌려준다.
 *    **다시 보낼 차례다.**
 *  · 기록이 `SENT` 거나 수명이 **남은** `SENDING` → 아무것도 안 하고 안 돌려준다.
 *    **이미 보냈거나 다른 요청이 보내는 중이다.**
 *
 * 🔴 같은 열쇠가 **한 문장 안에 두 번** 들어오면 Postgres 가 거절한다(「같은 줄을
 * 두 번 고칠 수 없다」). 그 겹침은 여기 오기 전에 걸러진다 — approvals/plan.ts 의
 * `skippedDuplicate`. 주기 작업의 적기(mutations/approval-mail-deliveries.ts)와
 * 같은 전제이고, 같은 까닭으로 여기서 다시 접지 않는다.
 *
 * 🔴 **던지는 것을 막지 않는다.** 여기서 빈 목록을 돌려주면 「아무것도 못 찍었다」
 * 와 구별되지 않아 **메일이 조용히 안 나간다.** 부르는 쪽이 받아 적는다.
 */
export async function claimApprovalMailDeliveries(params: {
  userId: string;
  rows: readonly ApprovalDeliveryClaim[];
}): Promise<ApprovalDeliveryClaimed[]> {
  // 🔴 빈 배열이면 DB 를 건드리지 않는다. drizzle 은 `values([])` 를 오류로 본다.
  if (params.rows.length === 0) return [];

  return db
    .insert(approvalMailDeliveries)
    .values(
      params.rows.map((row) => ({
        userId: params.userId,
        clientId: row.clientId,
        itemId: row.itemId,
        kind: row.kind,
        status: APPROVAL_DELIVERY_SENDING,
        error: null,
      }))
    )
    .onConflictDoUpdate({
      target: [
        approvalMailDeliveries.userId,
        approvalMailDeliveries.clientId,
        approvalMailDeliveries.itemId,
      ],
      set: {
        status: APPROVAL_DELIVERY_SENDING,
        kind: sql`excluded."kind"`,
        // 지난번 실패의 말은 지운다 — 이제 다시 보내는 중이라 그 말은 틀렸다.
        error: null,
        // 🔴 `excluded."sent_at"` 이 아니다. 이 값이 곧 **수명을 재는 기준**이라
        // DB 에게 직접 묻는다(주기 작업의 적기와 같은 자리·같은 까닭).
        sentAt: sql`now()`,
      },
      /**
       * 🔴 **이 한 줄이 중복 방지 전부다.** 왼쪽의 칸 이름은 **이미 있던 줄**을
       * 가리킨다(`excluded` 가 아니다 — 새로 들어온 값이 아니라 지금 표에 있는 값과
       * 견준다).
       *
       *  · 이미 `SENT` 면 덮지 않는다 → 같은 결재가 두 번 안 간다.
       *  · `SENDING` 인데 수명이 남았으면 덮지 않는다 → 동시에 둘이 들어와도
       *    한 통만 간다.
       *  · 수명이 지난 `SENDING` 은 덮는다 → 찍어 놓고 죽은 줄을 되살린다.
       *
       * 🔵 수명은 `make_interval` 로 **값을 바인딩해** 넣는다. 글자로 이어 붙이면
       * (`interval '300000 milliseconds'`) 상수가 SQL 본문에 구워지고, 그 모양은
       * 나중에 눈으로 읽기도 바꾸기도 나쁘다.
       *
       * 🔴 `::double precision` 은 **빼면 안 된다.** 바인딩 자리(`$n`)만 두면
       * Postgres 가 그 값의 타입을 정할 근거가 없어 「parameter 의 자료형을 알 수
       * 없다」로 **문장 자체가 거절된다.** 타입 검사도 시험도 이것을 못 잡는다 —
       * 진짜 DB 에 보내 봐야 드러나는 자리다.
       */
      setWhere: sql`
        ${approvalMailDeliveries.status} <> ${APPROVAL_DELIVERY_SENT}
        and (
          ${approvalMailDeliveries.status} <> ${APPROVAL_DELIVERY_SENDING}
          or ${approvalMailDeliveries.sentAt} <= now() - make_interval(secs => ${
            APPROVAL_SENDING_LEASE_MS / 1000
          }::double precision)
        )
      `,
    })
    .returning({
      clientId: approvalMailDeliveries.clientId,
      itemId: approvalMailDeliveries.itemId,
    });
}
