import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { notificationAcknowledgements } from "@/lib/db/schema";
import type { AcknowledgementRow } from "@/lib/notifications/acknowledgements";

/**
 * 확인한 알림을 적는다. 들어오는 줄은 **포털이 제 목록에서 지문까지 계산해 둔
 * 것**이다(notifications/acknowledgements.ts 의 acknowledgementRowsFor — 사이트가
 * 보낸 지문은 쓰지 않는다).
 *
 * 🔴 **있으면 고치고 없으면 넣는다(upsert).** 지움이 `onConflictDoNothing()` 인
 * 것과 **다른 자리**다. 까닭은 뜻이 다르기 때문이다:
 *  · 지움은 두 번 눌러도 뜻이 같아 **넘어가면** 된다(열쇠만 적으므로 적을 것이 없다).
 *  · 확인은 **덮어써야 한다.** 내용이 바뀌어 다시 뜬 줄을 사람이 또 확인한 것이고,
 *    그 뜻은 「**새 내용**을 확인했다」다. 넘어가면 옛 지문이 남아 그 줄이 영영
 *    다시 뜬다 — 눌러도 안 사라지는 알림이 된다.
 * 🔵 분류 저장(mutations/notification-kind-purposes.ts)이 같은 판단을 했다.
 *
 * 🔴 **한 문장으로 넣는다.** 한 요청의 열쇠가 최대 200개라(dismissals.ts 의
 * MAX_DISMISSAL_KEYS_PER_REQUEST — 확인 통로도 같은 상한을 쓴다) 줄마다 부르면
 * 왕복이 200번이다.
 */
export async function recordAcknowledgements(
  userId: string,
  rows: readonly AcknowledgementRow[]
): Promise<void> {
  // 🔴 빈 배열이면 DB 를 건드리지 않는다. drizzle 은 `values([])` 를 오류로 본다 —
  // 넣을 칸이 없어 SQL 을 지을 수 없기 때문이다. 보낸 열쇠가 전부 목록에 없는
  // 경우가 실제로 흔하므로(해소된 뒤 눌렀거나 이미 확인해 둔 줄) 사고가 아니다.
  if (rows.length === 0) return;

  await db
    .insert(notificationAcknowledgements)
    .values(
      rows.map((row) => ({
        userId,
        notificationKey: row.notificationKey,
        contentDigest: row.contentDigest,
      }))
    )
    .onConflictDoUpdate({
      target: [
        notificationAcknowledgements.userId,
        notificationAcknowledgements.notificationKey,
      ],
      set: {
        // 🔵 `excluded` 는 들어오려다 부딪힌 그 줄이다. 값을 바인딩으로 박지
        // 않는 까닭: 한 문장에 여러 줄이 실려 오므로 줄마다 값이 다르다.
        contentDigest: sql`excluded."content_digest"`,
        // 🔴 `excluded."acknowledged_at"` 이 아니다. 새 줄은 이 칸을 싣지 않아
        // (칸에 기본값이 있다) excluded 쪽 값이 비어 들어올 수 있다. 확인한
        // 시각은 지금이므로 DB 에게 직접 묻는다.
        acknowledgedAt: sql`now()`,
      },
    });
}

/**
 * 🔴 **이 파일에 `clearAcknowledgements` 는 없다. 일부러 없다.**
 *
 * 로그아웃 라우트 둘(`api/oidc/logout`·`api/session/logout`)이 지움 기록을
 * `clearDismissals` 로 비우는데, 확인은 **거기 따라붙으면 안 된다.** 「로그아웃하면
 * 돌아온다」가 ✕ 지움의 뜻이고, 확인의 뜻은 그 반대다(「해소됐다」).
 *
 * 🔵 표를 나눠 두었으므로 저절로 안전하다 — `clearDismissals` 는 지움 표만
 * 지운다. 그래도 적어 두는 까닭은 다음 사람이 **「통일성」을 이유로** 둘을 한
 * 표로 합치거나 로그아웃에 한 줄을 더하지 않게 하기 위해서다. 그렇게 하면
 * 증상이 「한참 뒤에 보니 확인해 둔 알림이 다 돌아와 있다」가 되는데, 그 말은
 * 로그아웃을 가리키지 않아 아무도 원인을 못 찾는다.
 * 🔵 못 박는 시험은 acknowledgements.test.ts 맨 아래에 있다.
 */
