import { NextResponse } from "next/server";
import { recordAcknowledgements } from "@/lib/db/mutations/notification-acknowledgements";
import {
  getActiveClient,
  hasClientAccess,
  verifyClientSecret,
  type ClientRecord,
} from "@/lib/db/queries/oidc-clients";
import { getUserById } from "@/lib/db/queries/users";
import { keyForRequest, siteNotificationFailureLimiter } from "@/lib/http/rate-limits";
import { NO_STORE } from "@/lib/notifications/site-feed";
import { handleAcknowledgementRequest } from "@/lib/notifications/site-acknowledgements";
import { getNotificationFeed } from "@/lib/notifications/service";

/**
 * ============================================================================
 * 각 사이트의 **서버**가 부르는 통로 — 「이 사람이 이 알림들을 **확인했다**」
 * ============================================================================
 *   POST {포털}/api/integration/notification-acknowledgements
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   sub=<포털 users.id (ID 토큰의 sub)>&keys=<열쇠,열쇠,...>
 *
 * 답(200): { recorded, dropped, skipped }
 *
 * 지움 통로(api/integration/notification-dismissals)와 **짝이다.** 왜 POST 인지,
 * 왜 세션이 아니라 client_secret 인지, 사칭을 왜 받아들이는지는 전부 저쪽과 같은
 * 까닭이고 site-feed.ts 맨 위에 적혀 있다. 판정은 site-acknowledgements.ts 에
 * 있고 여기는 그것을 진짜 함수로 채우는 껍데기다.
 *
 * 🔴 **✕ 지움과 뜻이 다르다.** 지움은 「지금은 그만 보겠다」라 로그아웃하면
 * 돌아오고, 확인은 「해소됐다」라 안 돌아온다. 그래서 표가 둘이다.
 *
 * ── 🔴 지문은 사이트가 보내지 않는다 ───────────────────────────────────────
 * 사이트가 보내는 것은 **열쇠뿐**이다. 「그때 본 내용」의 지문은 포털이 아래
 * `feedFor` 로 제 목록을 받아 직접 계산한다. 까닭은 site-acknowledgements.ts 맨
 * 위에 길게 적었다 — 사이트가 지문을 정할 수 있으면 아무 값이나 넣어 그 알림을
 * 영영 안 보이게 만들 수 있다.
 *
 * ── 🔴 왜 `getNotificationFeed` 이고 `getSiteNotificationFeed` 가 아닌가 ────
 * 읽기·지움 통로는 **부른 사이트 자신의 알림을 빼고** 답한다(site-service.ts 맨
 * 위의 `exceptClientId` — 되돌기를 막는 네 가지 까닭이 거기 있다). 이 통로만
 * 그러지 않는다. 까닭:
 *
 *  · 사이트의 종에는 **포털이 모아 준 줄과 그 사이트 제 줄이 함께** 그려진다.
 *    사람이 ✓ 를 누르는 줄 가운데 상당수가 **그 사이트 자신의 줄**이다. 뺀
 *    목록으로 지문을 지으면 그 줄들은 **언제나 `skipped`** 가 되어 영영 적히지
 *    않는다. 🔴 이 조각이 지키려는 바로 그 예(재고관리의 「한계수량 이하인
 *    부품이 N종 더」)가 **재고관리 제 줄**이라, 뺀 목록으로는 그 예가 통째로
 *    동작하지 않는다.
 *  · 되돌기를 막는 네 까닭은 **읽기 길의 것**이다. ①「이미 아는 것을 돌아 받는다」
 *    — 여기서는 아니다. 포털은 **사이트를 믿지 않으려고** 제 손으로 받아야 한다.
 *    ④「화면 한 장에 왕복이 하나 는다」 — 이것은 화면을 그리는 길이 아니라
 *    사람이 ✓ 를 누를 때만 도는 길이다.
 *  · ⚠️ ②(30초 캐시)만 조금 남는다: 내용이 방금 바뀐 줄을 ✓ 하면 **옛 지문**이
 *    적힐 수 있고, 그러면 그 줄이 곧바로 다시 뜬다. 🔵 사고가 아니라 **스스로
 *    낫는다** — 다시 ✓ 를 누르면 그때는 새 지문이 적힌다. 반대 방향(안 본 내용이
 *    숨는 것)도 최대 30초짜리다.
 *
 * 🔵 새는 것은 없다. 이 통로는 목록을 **돌려주지 않고** 숫자 셋만 답한다. 그리고
 * `getNotificationFeed` 가 묻는 범위는 `listAccessibleClients` 로 좁혀져 있어,
 * 읽기 통로가 이미 그 사이트에 내주고 있는 범위와 같다.
 * ============================================================================
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let result;
  try {
    result = await handleAcknowledgementRequest<ClientRecord>(request, {
      // 🔴 판정에 쓰는 함수는 전부 **포털에 이미 있는 것**이고, 읽기·지움 통로가
      // 쓰는 것과 **같은 넷**이다. 하나라도 다른 것을 끼우면 「알림은 오는데
      // 확인만 안 먹히는」 사람이 생기고, 그 어긋남은 신고로만 드러난다.
      findActiveClient: getActiveClient,
      verifySecret: verifyClientSecret,
      findUser: getUserById,
      hasAccess: hasClientAccess,
      feedFor: ({ userId }) => getNotificationFeed(userId),
      record: ({ userId, rows }) => recordAcknowledgements(userId, rows),
      // 🔴 **읽기·지움 통로와 같은 통을 쓴다.** 세 통로가 **같은 자격증명**을
      // 받으므로, 통을 나누면 시크릿을 두드리는 쪽이 분당 20번을 세 번 얻는다.
      countAuthFailure: () =>
        siteNotificationFailureLimiter.check(keyForRequest(request), Date.now()),
    });
  } catch (error) {
    // DB 가 죽은 것 같은 경우다. 🔴 500 대신 503 으로 「지금은 안 된다」를 분명히
    // 말한다 — 다른 두 통로와 같다. 🔵 그리고 이 통로는 **몇 번을 다시 보내도
    // 안전하므로**(site-acknowledgements.ts) 사이트가 503 을 받고 재시도해도 된다.
    console.error("[notifications] 알림 확인을 적지 못했습니다:", error);
    return NextResponse.json(
      { error: "temporarily_unavailable", error_description: "지금은 확인을 적을 수 없습니다." },
      { status: 503, headers: NO_STORE }
    );
  }

  if (result.logReason) {
    // 🔴 거절은 **반드시 한 줄 남긴다.** 남기는 것은 까닭 하나뿐이다 — 사람의
    // id 도, 비밀값도, 열쇠도 적지 않는다(열쇠에는 수리 건 번호 같은 업무
    // 식별자가 들어 있다).
    console.warn(`[notifications] 알림 확인 요청 거절 ${result.status} (${result.logReason})`);
  }

  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
