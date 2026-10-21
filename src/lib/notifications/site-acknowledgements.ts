import { acknowledgementRowsFor, type AcknowledgementRow } from "./acknowledgements";
import { MAX_DISMISSAL_KEYS_PER_REQUEST, readDismissalKeys } from "./dismissals";
import type { PortalNotificationFeed } from "./merge";
import {
  authorizeSiteRequest,
  NO_STORE,
  reject,
  type SiteFeedResponse,
  type SiteRequestDeps,
} from "./site-feed";

/**
 * ============================================================================
 * 사이트가 「이 사람이 이 알림들을 **확인했다**」를 적으러 오는 통로 — 판정 전부
 * ============================================================================
 *   POST {포털}/api/integration/notification-acknowledgements
 *   Authorization: Basic base64(client_id:client_secret)
 *   sub=<포털 users.id>&keys=<열쇠,열쇠,...>
 *
 * 지움 통로(site-dismissals.ts)와 **방향도 자격증명도 문 여섯도 같다.** 다른 것은
 * 둘이다:
 *
 *  1. 🔴 **뜻이 다르다.** 지움은 「지금은 그만 보겠다」라 로그아웃하면 돌아오고,
 *     확인은 「해소됐다」라 **안 돌아온다.** 적는 표도 다르다.
 *  2. 🔴 **적을 것이 열쇠 하나가 아니다.** 확인에는 「그때 본 내용」의 지문이 함께
 *     들어가고, 그 지문은 **포털이 직접 계산한다**(아래).
 *
 * ── 🔴 보내온 지문을 믿지 않는다 — 이 통로의 핵심 ──────────────────────────
 * 사이트는 **열쇠만** 보낸다. 지문 칸은 받지도 않는다. 포털이 제 목록에서 그 줄을
 * 찾아 `contentDigest(subject, detail)` 로 직접 짓는다.
 *
 * 사이트가 지문을 정할 수 있으면 **아무 값이나 넣어 그 알림을 영영 안 보이게**
 * 만들 수 있다 — 거르는 조건이 「저장된 지문 == 지금 내용의 지문」뿐이기
 * 때문이다. 🔴 자격이 있는 사이트라도 그 권한까지 준 적은 없다. 이 통로가 받은
 * 권한은 「이 사람이 이 줄을 확인했다」를 전하는 것이고, 「이 줄을 영구히 숨겨라」
 * 가 아니다.
 *
 * 🔵 지움 통로가 사칭 위험을 받아들인 근거는 「숨겨도 하루 안에 저절로 돌아온다」
 * 였다(설계안 5절 ③). 확인은 **돌아오지 않으므로** 그 근거를 쓸 수 없고, 그래서
 * 같은 문 여섯 위에 이 한 줄을 더 얹는다.
 *
 * ── 🔵 몇 번을 다시 보내도 안전하다 ────────────────────────────────────────
 * `record` 가 upsert 라(mutations/notification-acknowledgements.ts) 같은 열쇠를
 * 두 번 보내면 같은 지문으로 덮어쓸 뿐이다. 응답이 끊겨 재시도해도, 화면 둘에서
 * 같은 ✓ 를 눌러도 아무 일이 없다.
 * ============================================================================
 */

/** 적는 일과 **목록을 가져오는 일**이 문 여섯에 더 붙는다. */
export type AcknowledgementDeps<C extends { clientId: string }> = SiteRequestDeps<C> & {
  /**
   * 🔴 **포털이 아는 그 사람의 알림 전부.** 지문의 재료는 여기서만 온다.
   *
   * 🔵 `clientId` 를 받지 않는 것이 뜻이다 — 읽기 통로처럼 「부른 사이트를 뺀
   * 목록」이 아니라 **부른 사이트의 줄까지 든 목록**이어야 한다. 까닭은 라우트에
   * 적었다(사람이 ✓ 를 누르는 줄 가운데 상당수가 **그 사이트 자신의 줄**이다).
   */
  feedFor(params: { userId: string }): Promise<PortalNotificationFeed>;
  /** 확인을 적는다. 같은 열쇠는 덮어쓴다. */
  record(params: { userId: string; rows: AcknowledgementRow[] }): Promise<void>;
};

/**
 * 한 번의 확인 요청을 끝까지 판정하고 적는다.
 *
 * 🔴 **이 함수는 던지지 않는다** — 문 여섯도(`authorizeSiteRequest`) 열쇠 읽기도
 * (`readDismissalKeys`) 무엇이 와도 값을 돌려주게 지어져 있다. 남은 둘
 * (`feedFor`·`record`)이 던지는 경우는 DB 나 저쪽 시스템이 죽은 때라 라우트가
 * 503 으로 받는다.
 *
 * 순서는 지움 통로와 **같다**:
 *   1. 문 여섯 — 막히면 그 응답을 **그대로** 돌려준다
 *   2. 🔴 **그 다음에** 열쇠 — 인증을 통과하지 못한 쪽이 열쇠 검사 결과를 보면
 *      이 통로가 「이 열쇠 모양이 맞나」를 물어보는 도구가 된다(저쪽 주석).
 *   3. 통과하면 **포털 목록에서 찾아** 지문을 짓고, 적고, 200
 *
 * ── 🔴 왜 열쇠 읽기를 지움 통로 것으로 쓰는가 ─────────────────────────────
 * 본문 모양(`keys=a,b,c`)도, 열쇠 문법(`{client_id}:{id}`)도, 한 요청의 개수
 * 상한도 **같은 사실**이다. 베껴 두면 한쪽만 고치는 날 조용히 갈라지고, 갈라진
 * 것이 열쇠 판정이면 증상이 「어떤 시스템의 확인만 안 먹힌다」 하나뿐이다.
 * 🔵 거절 **문구**만 이 통로의 것으로 짓는다 — 「지울 열쇠가 없습니다」가 확인
 * 통로에서 나오면 붙이는 쪽이 엉뚱한 곳을 고친다.
 */
export async function handleAcknowledgementRequest<C extends { clientId: string }>(
  request: Request,
  deps: AcknowledgementDeps<C>
): Promise<SiteFeedResponse> {
  // 1. 문 여섯. 🔴 거절은 **그대로** 돌려준다 — 손대는 순간 통로들이 갈라진다.
  const authorized = await authorizeSiteRequest(request, deps);
  if (!authorized.ok) return authorized.response;

  // 2. 🔴 본문은 `authorizeSiteRequest` 가 읽어 넘겨준 것이다. `request.text()`
  //    를 여기서 다시 부르면 빈 문자열이 온다(site-feed.ts 의 그 주석).
  const read = readDismissalKeys(authorized.body);

  if (!read.ok) {
    if (read.reason === "no_keys") {
      return reject(
        400,
        "invalid_request",
        "확인할 열쇠가 없습니다. keys 에 `{client_id}:{id}` 모양의 열쇠를 쉼표로 이어 보내세요.",
        "no_keys"
      );
    }

    // 🔴 **「나눠 보내라」가 들어 있어야 한다.** 이 말이 없으면 붙이는 쪽은 400 을
    //    받고도 무엇을 고쳐야 하는지 모른다(지움 통로와 같은 까닭).
    return reject(
      400,
      "invalid_request",
      `한 번에 보낼 수 있는 열쇠는 ${MAX_DISMISSAL_KEYS_PER_REQUEST}개입니다. ${MAX_DISMISSAL_KEYS_PER_REQUEST}개씩 나눠 보내세요.`,
      "too_many_keys"
    );
  }

  // 3. 🔴 **포털 제 목록에서** 그 줄을 찾아 지문을 짓는다. 보내온 값이 아니다.
  const feed = await deps.feedFor({ userId: authorized.subject });
  const { rows, skipped } = acknowledgementRowsFor(feed.items, read.keys);

  // 🔵 적을 것이 하나도 없어도 **200 이다.** 보낸 쪽이 잘못한 것이 없다 — 그 사이
  //    알림이 해소되어 목록에서 빠졌거나, 이미 확인해 둔 줄이거나, ✕ 로 지워 둔
  //    줄이다. 셋 다 흔하다. 400 으로 만들면 「✓ 를 눌렀는데 빨간 알림이 뜬다」가
  //    되고, 사람은 눌리지 않은 줄 알고 다시 누른다.
  await deps.record({ userId: authorized.subject, rows });

  return {
    status: 200,
    body: {
      /**
       * 🔴 **표에 적은 줄 수다.** 지움 통로의 `recorded`(「보낸 것 중 뜻이 지켜진
       * 수」)와 뜻이 다르고, 그래야 한다 — 저쪽은 열쇠만 적으므로 「뜻이 지켜졌나」
       * 를 보낸 열쇠만으로 답할 수 있지만, 여기서는 **포털이 그 줄을 찾았는가**가
       * 갈림길이다. 못 찾으면 적을 수 없고(지문의 재료가 없다), 그 사실은 아래
       * `skipped` 가 말한다.
       */
      recorded: rows.length,
      /**
       * 모양이 틀렸거나 모르는 시스템이라 **조용히 버린** 수.
       * 🔵 빈 조각과 중복은 여기 안 센다(dismissals.ts). 0 이 아니면 보내는 쪽의
       * 배포가 어긋났다는 뜻이다.
       */
      dropped: read.dropped,
      /**
       * 🔴 **열쇠는 멀쩡한데 포털 목록에 없어 넘어간 수. 실패가 아니다.**
       *
       * 붙이는 쪽은 이 숫자를 보고 **재시도하면 안 된다.** 다시 보내도 같은 답이
       * 온다 — 그 줄은 이미 목록에 없기 때문이다. 사람에게 실패를 알리는 것도
       * 틀린 행동이다. 그 사람이 본 화면에서는 알림이 사라진 것이 맞다.
       */
      skipped,
    },
    headers: NO_STORE,
  };
}
