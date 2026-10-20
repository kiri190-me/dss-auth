import { MAX_DISMISSAL_KEYS_PER_REQUEST, readDismissalKeys } from "./dismissals";
import {
  authorizeSiteRequest,
  NO_STORE,
  reject,
  type SiteFeedResponse,
  type SiteRequestDeps,
} from "./site-feed";

/**
 * ============================================================================
 * 사이트가 「이 사람이 이 알림들을 지웠다」를 적으러 오는 통로 — 판정 전부
 * ============================================================================
 * 읽기 통로(site-feed.ts)와 **방향도 자격증명도 같다.** 다른 것은 하나뿐이다:
 * 저쪽은 내주고 이쪽은 **적는다.**
 *
 *   POST {포털}/api/integration/notification-dismissals
 *   Authorization: Basic base64(client_id:client_secret)
 *   sub=<포털 users.id>&keys=<열쇠,열쇠,...>
 *
 * ── 🔴 문 여섯을 베끼지 않았다 ─────────────────────────────────────────────
 * 설계안 3-5 는 「읽기 통로의 문 여섯을 순서까지 그대로 베낀다」고 적었다. 뜻은
 * 옳지만 방법이 틀렸다 — 「순서까지 그대로」는 **베껴서는 지킬 수 없는 성질**이다.
 * 베낀 쪽과 원본은 한쪽만 고치는 날이 오면 갈라지고, 갈라진 것이 보안 판정이면
 * **아무 증상도 없어서** 갈라졌다는 사실 자체를 아무도 모른다. 그래서 떼어내
 * 한 벌로 만들었다(`authorizeSiteRequest`). 한 벌이면 갈라질 길이 없다.
 *
 * ── 🔴 쓰기라서 더 걸린 것 ─────────────────────────────────────────────────
 * 설계안 5절 ③ 이 적어 둔 그대로다. 읽기에서 사칭으로 새는 것은 「남의 밀린 일
 * 건수」지만, 쓰기에서는 **「그 시스템을 쓸 수 있는 아무 사람의 알림이나 숨길 수
 * 있다」**가 된다. 받아들이는 까닭도 거기 있다 — 문 ⑥(hasAccess)이 그대로
 * 걸리므로 **그 시스템에 권한이 있는 사람**에 한정되고, 숨긴 것은 하루 안에
 * 저절로 돌아온다(로그아웃 또는 보관 기간). 🔵 **지워지는 자료가 아니라 보기를
 * 미루는 것이다.**
 *
 * ── 🔵 몇 번을 다시 보내도 안전하다 ────────────────────────────────────────
 * `recordDismissals` 가 `onConflictDoNothing()` 으로 **이미 있는 열쇠를 조용히
 * 넘긴다**(mutations/notification-dismissals.ts). 그래서 응답이 끊겨 사이트가
 * 재시도해도, 화면 둘에서 같은 ✕ 를 눌러도 아무 일이 없다 — 두 번 지우는 것은
 * 한 번 지우는 것과 **뜻이 같다.**
 *
 * 🔴 쓰기 통로에서는 이 성질이 **있는지 없는지가 중요하다.** 없으면 붙이는 쪽이
 * 「끊겼을 때 다시 보내도 되는가」를 스스로 판단해야 하고, 그 판단은 통로마다
 * 달라져 결국 틀린다. 여기서는 **언제나 다시 보내도 된다**가 답이다.
 * ============================================================================
 */

/** 적는 일 하나가 문 여섯에 더 붙는다. */
export type DismissalDeps<C extends { clientId: string }> = SiteRequestDeps<C> & {
  /** 그 사람의 지움 기록에 열쇠들을 적는다. 이미 있는 것은 조용히 넘어간다. */
  record(params: { userId: string; keys: string[] }): Promise<void>;
};

/**
 * 한 번의 지움 요청을 끝까지 판정하고 적는다.
 *
 * 🔴 **이 함수는 던지지 않는다** — 문 여섯도(`authorizeSiteRequest`) 열쇠 읽기도
 * (`readDismissalKeys`) 무엇이 와도 값을 돌려주게 지어져 있다. 남은 하나는
 * `deps.record` 뿐이고, 그것이 던지는 경우는 **DB 가 죽은 때**라 라우트가
 * 503 으로 받는다(읽기 통로의 `feedFor` 와 같은 모양이다).
 *
 * 순서:
 *   1. 문 여섯 — 막히면 그 응답을 **그대로** 돌려준다
 *   2. 🔴 **그 다음에** 열쇠 — 문 일곱(개수 상한)과 여덟(열쇠 모양)
 *   3. 통과하면 적고 200
 *
 * ── 🔴 왜 열쇠 검사가 여섯 **뒤**인가 ──────────────────────────────────────
 * 인증을 통과하지 못한 쪽이 열쇠 검사 결과를 보면 안 된다. 보이면 이 통로가
 * 「**이 열쇠 모양이 맞나**」를 물어보는 도구가 된다 — 자격증명 없이 400 과
 * 401 을 갈라 보는 것만으로 `{client_id}:{id}` 규칙과 **등록된 알림 시스템
 * 목록**(dismissals.ts 가 NOTIFICATION_SOURCE_PATHS 로 판정한다)을 하나씩
 * 짚어 낼 수 있다. 그것은 읽기 통로가 401 과 403 을 한 얼굴로 돌려주며 막아
 * 둔 바로 그 조회다. 설계안 3-5 도 문 일곱·여덟을 「**추가로** 이 통로만의
 * 문 둘」로 여섯 뒤에 두었다.
 */
export async function handleDismissalRequest<C extends { clientId: string }>(
  request: Request,
  deps: DismissalDeps<C>
): Promise<SiteFeedResponse> {
  // 1. 문 여섯. 🔴 거절은 **그대로** 돌려준다 — 손대는 순간 두 통로가 갈라진다.
  const authorized = await authorizeSiteRequest(request, deps);
  if (!authorized.ok) return authorized.response;

  // 2. 🔴 본문은 `authorizeSiteRequest` 가 읽어 넘겨준 것이다. `request.text()`
  //    를 여기서 다시 부르면 빈 문자열이 온다(저쪽 주석).
  const read = readDismissalKeys(authorized.body);

  if (!read.ok) {
    if (read.reason === "no_keys") {
      return reject(
        400,
        "invalid_request",
        "지울 열쇠가 없습니다. keys 에 `{client_id}:{id}` 모양의 열쇠를 쉼표로 이어 보내세요.",
        "no_keys"
      );
    }

    // 🔴 **「나눠 보내라」가 들어 있어야 한다.** 이 말이 없으면 붙이는 쪽은 400 을
    //    받고도 무엇을 고쳐야 하는지 모른다 — 상한을 올려 달라고 하거나, 지움을
    //    통째로 포기한다. 한 번에 보낼 수 있는 수를 적어 주면 그 자리에서 나눈다.
    return reject(
      400,
      "invalid_request",
      `한 번에 보낼 수 있는 열쇠는 ${MAX_DISMISSAL_KEYS_PER_REQUEST}개입니다. ${MAX_DISMISSAL_KEYS_PER_REQUEST}개씩 나눠 보내세요.`,
      "too_many_keys"
    );
  }

  // 3. 적는다. 🔵 모양이 틀렸거나 모르는 시스템의 열쇠는 이미 빠져 있다
  //    (dismissals.ts — 한 줄 때문에 일괄 전체를 거절하지 않는다).
  await deps.record({ userId: authorized.subject, keys: read.keys });

  return {
    status: 200,
    body: {
      /**
       * 🔴 **「보낸 것 중 뜻이 지켜진 수」다. 표에 새로 생긴 행 수가 아니다.**
       *
       * 이미 지워져 있던 열쇠는 `onConflictDoNothing()` 이 조용히 넘기므로 행은
       * 안 늘지만, 그 알림은 **지워진 상태가 맞다** — 보낸 쪽의 뜻은 지켜졌다.
       * 행 수를 돌려주면 두 번째 요청이 `recorded: 0` 을 받고 붙이는 쪽이
       * 「덜 적혔다」고 읽는다. 그러면 재시도를 하거나 사람에게 실패를 알리는데,
       * **둘 다 틀린 행동**이다. 🔵 같은 열쇠를 두 번 실어 보낸 경우도 같다 —
       * 중복은 하나로 세고(dismissals.ts), 그 하나가 뜻이다.
       */
      recorded: read.keys.length,
      /**
       * 모양이 틀렸거나 모르는 시스템이라 **조용히 버린** 수.
       *
       * 🔵 빈 조각과 중복은 여기 안 센다(dismissals.ts). 이 숫자가 0 이 아니면
       * 보내는 쪽의 배포가 어긋났다는 뜻이라, 붙이는 쪽이 로그에 남길 수 있게
       * 돌려준다.
       */
      dropped: read.dropped,
    },
    headers: NO_STORE,
  };
}
