import { NextResponse } from "next/server";
import { getNotificationFeed } from "@/lib/notifications/service";
import { readSsoSession } from "@/lib/session/sso-session";

/**
 * ============================================================================
 * 합쳐진 알림을 내주는 창구
 * ============================================================================
 * 포털이 각 시스템에 물어 합친 결과를 **포털 세션으로** 내준다. 다음 조각(종)이
 * 이것을 부른다.
 *
 * ── 왜 라우트도 두는가(함수만으로 충분하지 않은가) ──────────────────────────
 * 포털 화면 안에서는 `getNotificationFeed(userId)` 를 서버 컴포넌트가 바로 부르면
 * 된다. 그런데 종은 **열어 둔 채로 다시 세는** 물건이다(A/S 종은 1분마다 다시
 * 센다). 화면을 통째로 다시 그리지 않고 숫자만 갱신하려면 브라우저가 부를 수
 * 있는 주소가 있어야 한다. 그래서 둘 다 둔다 — 첫 그림은 함수로, 이후 갱신은
 * 이 주소로.
 *
 * ── 누구의 알림인가 ────────────────────────────────────────────────────────
 * 🔴 **세션에서만 온다.** 쿼리로 사용자를 받지 않는다 — 받는 순간 로그인한
 * 아무나가 남의 알림을 볼 수 있는 문이 된다. 각 시스템의 통로가 대상 사용자를
 * 토큰 안에서만 받는 것과 같은 규칙이다(A/S portal-service-token.ts 의 8번).
 *
 * GET 인 것은 읽기뿐이기 때문이다. 이 응답은 사람마다 다르고 매번 달라지므로
 * 어디에도 남으면 안 된다(no-store).
 * ============================================================================
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET() {
  const session = await readSsoSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  // 승인 대기·정지 상태에서는 어느 시스템에도 들어갈 수 없다. 화면이 /pending
  // 으로 보내는 것과 같은 줄을 여기서도 긋는다.
  if (session.status !== "ACTIVE") {
    return NextResponse.json({ error: "not_active" }, { status: 403, headers: NO_STORE });
  }

  return NextResponse.json(await getNotificationFeed(session.userId), { headers: NO_STORE });
}
