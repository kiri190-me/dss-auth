"use server";

import { revalidatePath } from "next/cache";
import type { NotificationBellItem } from "@dss/ui";
import { recordAcknowledgements } from "@/lib/db/mutations/notification-acknowledgements";
import { recordDismissals } from "@/lib/db/mutations/notification-dismissals";
import { acknowledgementRowsFor } from "@/lib/notifications/acknowledgements";
import { readBellKey } from "@/lib/notifications/bell-key";
import { getNotificationFeed } from "@/lib/notifications/service";
import { readSsoSession } from "@/lib/session/sso-session";

/**
 * ============================================================================
 * 포털 제 화면의 종이 누르는 자리 둘 — ✕「그만 보겠다」와 줄 누름「해소됐다」
 * ============================================================================
 * 2026-11-18, 앱 목록 화면(`/apps`)에 종을 달면서 생겼다. 적는 일 자체는 이미
 * 다 있었다(mutations/notification-dismissals.ts ·
 * mutations/notification-acknowledgements.ts) — 없던 것은 **브라우저에서 그
 * 둘로 가는 길**뿐이다.
 *
 * ── 🔴 왜 기존 HTTP 통로를 쓰지 않는가 ────────────────────────────────────
 * `POST /api/integration/notification-dismissals`(와 확인 쪽)은 **사이트의
 * 서버**가 `client_id`/`client_secret` 으로 부르는 통로다(site-feed.ts 의 문
 * 여섯). 포털이 제 브라우저 세션으로 그것을 부르려면 **포털이 자기 자신에게
 * 시크릿을 발급해** 들고 있어야 한다 — 자격증명을 하나 더 만들고, 그것을
 * 보관하고, 제 손으로 돌려 가며 쓰는 일이다. 그런데 여기는 **같은
 * 프로세스**라서 HTTP 왕복 없이 mutation 을 바로 부르면 된다. 통로를 거치면서
 * 얻는 것(문 여섯)은 사이트를 못 믿어서 세운 울타리이고, 여기서는 사람이
 * 포털에 **직접 로그인한 세션**이라 그 울타리가 가려 내려던 것이 애초에 없다.
 *
 * ── 🔴 누구의 알림인지는 **서버가** 정한다 ────────────────────────────────
 * 사람 번호를 인자로 받지 않는다. 받으면 브라우저가 아무 번호나 실어 남의
 * 알림을 지울 수 있다. 아래 `actingUserId` 가 제 쿠키에서 세션을 다시 읽어
 * 그 값을 쓴다 — 화면(`/apps`)이 이미 세션을 봤더라도 **서버 액션은 따로 다시
 * 검증한다.** 액션은 화면을 거치지 않고 직접 불릴 수 있다(옆 파일
 * notification-settings.ts 가 같은 까닭으로 포털 관리자 여부를 스스로 본다).
 *
 * 🔴 **`redirect` 하지 않는 `readSsoSession` 을 쓴다.** 이 함수들은 사람이 종의
 * 단추를 누른 **그 순간** 불리는데, 세션이 막 끊긴 경우에 알림 한 줄 때문에
 * 보던 화면이 로그인으로 튀어서는 안 된다. 그때는 아무 일도 일어나지 않는
 * 편이 맞다.
 *
 * ── 🔴 던지지 않는다 ──────────────────────────────────────────────────────
 * @dss/ui 의 곁들이 조각(BellBehavior)이 이 함수들을 **누름 처리 한가운데서**
 * 부른다. 여기서 예외가 새면 그 누름의 나머지 처리(바깥 눌러 접기·Esc)가
 * 통째로 멈춘다. 못 적으면 그 줄이 종에 남을 뿐이다.
 * ============================================================================
 */

/**
 * 종이 서 있는 화면. 🔴 되살릴 곳이 여기 하나인 까닭: 이 저장소에서 종을
 * 그리는 자리는 `/apps` **한 장**이다(관리자 화면에는 달지 않았다 —
 * 2026-11-18 사용자 결정). 레이아웃에 달린 다른 집들이
 * `revalidatePath("/", "layout")` 을 쓰는 것과 다른 점이다.
 */
const APPS_PATH = "/apps";

/**
 * 지금 누른 사람. 🔴 **쿠키에서 다시 읽는다** — 인자로 받지 않는다(머리말).
 *
 * 🔴 `status` 까지 본다. 정지·삭제된 사람은 `/apps` 가 `/pending` 으로
 * 돌려보내므로 화면에서는 종을 볼 수 없지만, 액션은 화면을 거치지 않고 불릴 수
 * 있다. 사이트가 부르는 HTTP 통로도 같은 자리에서 같은 값을 본다
 * (site-feed.ts 의 `subject_status`).
 */
async function actingUserId(): Promise<string | null> {
  const session = await readSsoSession();
  if (!session) return null;
  if (session.status !== "ACTIVE") return null;
  return session.userId;
}

/**
 * 종의 줄에서 ✕ 를 눌렀을 때 — 「이 알림은 그만 보겠다」를 포털에 적는다.
 *
 * 🔴 **확인(아래)과 다른 일이다.** 지움은 로그아웃하면 돌아오고(로그아웃
 * 라우트가 그 사람 행을 비운다) 확인은 안 돌아온다. 표도 둘이다.
 *
 * 🔵 **몇 번을 눌러도 안전하다** — `recordDismissals` 가
 * `onConflictDoNothing()` 이라 같은 열쇠를 두 번 지우면 한 번 지운 것과 같다.
 *
 * 🔵 한 번 지우면 **사내 시스템 전부의 종**에서 사라진다. 지움 기록은 포털 한
 * 곳에 있고 각 사이트는 포털이 돌려주는 목록을 받아 제 줄을 거른다
 * (dismissals.ts 의 applySiteDismissals).
 */
export async function dismissNotificationAction(item: NotificationBellItem): Promise<void> {
  try {
    const userId = await actingUserId();
    if (!userId) return;

    // 🔴 **브라우저를 거쳐 온 값이다.** 타입이 `NotificationBellItem` 이라고
    //    적혀 있어도 그 모양으로 오지 않는다 — 서버 액션의 인자는 tsc 가
    //    지키는 범위 밖이다. 모양을 가리는 자리는 bell-key.ts 하나다.
    // 🔵 이 열쇠로 할 수 있는 일은 「**내** 종에서 이 줄을 그만 보기」뿐이다 —
    //    누구의 지움인지는 바로 위에서 서버가 정했다.
    const key = readBellKey(item);
    if (key === null) return;

    await recordDismissals(userId, [key]);

    // ── 🔴 왜 되살려야 하는가 ─────────────────────────────────────────────
    // 포털은 모아 둔 목록을 30초 동안 기억하지만(service.ts 의 FEED_TTL_MS),
    // **지움은 캐시 바깥에서 매 요청 DB 로 다시 거른다**(그 파일의
    // withoutDismissed). 그래서 다음 렌더만 일어나면 줄이 바로 빠진다 — 이
    // 한 줄이 그 「다음 렌더」다.
    //
    // 🔵 **누른 그 자리에서 즉시 사라지지는 않는다.** 줄은 다음 렌더에서
    //    빠진다. 즉시 지우려면 종을 클라이언트 조각으로 바꾸고 목록 상태를
    //    브라우저에 들어야 하는데, 그러면 종이 서버 조각이라 얻고 있는 것
    //    (스크립트가 안 붙은 화면에서도 열린다)을 잃는다.
    revalidatePath(APPS_PATH);
  } catch (error) {
    // 🔴 조용히 넘어가지 않는다. 안 남기면 증상이 「지웠는데 그대로 뜬다」
    //    하나뿐이라 DB 를 의심할 단서가 없다(통로 쪽 라우트와 같은 문구다).
    console.error("[notifications] 알림 지움을 적지 못했습니다:", error);
  }
}

/**
 * 종의 줄을 눌렀을 때 — 「이 알림은 해소됐다」를 포털에 적는다.
 *
 * 🔴 **이동은 이 함수와 무관하게 일어난다.** 줄은 평범한 `<a href>` 라
 * 누르는 순간 그 시스템으로 건너가고, 적는 일은 그 옆에서 따로 간다. 여기서
 * 느려지거나 실패해도 **이동을 막으면 안 된다.**
 *
 * ── 🔴 지문은 **포털이 직접 짓는다** — 이 조각에서 가장 중요한 줄 ──────────
 * 보내온 줄의 `subject`·`detail` 을 쓰지 않는다. 받은 **열쇠로** 포털 제
 * 목록에서 그 줄을 찾아 `acknowledgementRowsFor` 가 지문을 계산한다. 믿고
 * 적으면 브라우저가 아무 값이나 넣어 그 알림을 **영영 안 보이게** 만들 수
 * 있다 — 거르는 조건이 「저장된 지문 == 지금 내용의 지문」이기 때문이다.
 * 까닭 전부는 acknowledgements.ts 머리말에 있다.
 *
 * ── 🔵 눌러도 안 사라지는 줄이 있다. 고장이 아니다 ────────────────────────
 * 확인이 목록에서 거르는 조건은 셋이 **모두** 맞아야 한다 — 기록이 있고 ·
 * 내용이 그때와 같고 · **분류가 `INFO`** 다. 분류의 기본값은 `ACTION`(승인용)
 * 이라(purposes.ts), 포털 관리자가 그 종류를 「정보 확인용」으로 바꾸기 전에는
 * 기록만 남고 줄은 종에 남는다. 결재처럼 **처리해야 사라지는** 알림을 눌러
 * 숨기지 않으려는 설계다.
 *
 * 🔵 **몇 번을 눌러도 안전하다** — `recordAcknowledgements` 가 upsert 라 같은
 * 열쇠를 다시 보내면 그때의 내용으로 덮어쓸 뿐이다.
 */
export async function acknowledgeNotificationAction(item: NotificationBellItem): Promise<void> {
  try {
    const userId = await actingUserId();
    if (!userId) return;

    // 🔴 ✕ 와 **같은 함수로** 가린다(bell-key.ts). 확인 쪽은 아래에서 목록에
    //    없는 열쇠를 어차피 버리므로 이 줄이 없어도 쓰레기가 안 쌓이지만, 두
    //    길이 같은 잣대를 쓰면 뒷날 한쪽만 느슨해질 자리가 없다.
    const key = readBellKey(item);
    if (key === null) return;

    // 🔴 **포털 제 목록**이다. 여기에 없는 열쇠는 적지 않는다 — 지문을 지을
    //    재료가 없고, 재료 없이 적으면 그 줄이 내용과 무관하게 영영 숨는다.
    // 🔵 이 조회는 30초 캐시를 탄다(service.ts) — 사람이 종을 열어 보고 누르는
    //    길이라 방금 그린 그 목록이 그대로 나온다.
    const feed = await getNotificationFeed(userId);
    const { rows } = acknowledgementRowsFor(feed.items, [key]);

    // 🔵 목록에 없어 적을 것이 없는 일은 **흔하다** — 그 사이 알림이 해소됐거나,
    //    이미 확인해 둔 줄이거나, ✕ 로 지워 둔 줄이다. 사고가 아니므로 조용히
    //    돌아간다. 🔴 그리고 **되살리지 않는다**: 아무것도 안 바뀌었으므로 하는
    //    일이라고는 화면을 쓸데없이 다시 그리는 것뿐이다.
    if (rows.length === 0) return;

    await recordAcknowledgements(userId, rows);
    revalidatePath(APPS_PATH);
  } catch (error) {
    // 🔴 지움과 같은 까닭으로 한 줄 남긴다. 안 남기면 증상이 「확인했는데 다시
    //    뜬다」 하나뿐이다.
    console.error("[notifications] 알림 확인을 적지 못했습니다:", error);
  }
}
