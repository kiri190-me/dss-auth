import {
  authorizeSiteRequest,
  NO_STORE,
  reject,
  type SiteFeedResponse,
  type SiteRequestDeps,
} from "@/lib/notifications/site-feed";
import type { PortalApprovalHistory } from "./history-gather";
import {
  APPROVAL_HISTORY_PERIOD_ERROR,
  readApprovalHistoryPeriod,
  type ApprovalHistoryPeriod,
} from "./history-period";

/**
 * ============================================================================
 * 승인함이 「이 사람이 이 기간에 한 결재」를 물으러 오는 통로 — 판정 전부
 * ============================================================================
 *   POST {포털}/api/integration/approval-history
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   sub=<포털 users.id (ID 토큰의 sub)>&from=<ISO8601>&to=<ISO8601>
 *
 * 방향도 자격증명도 옆의 결재함 통로(screen-request.ts)와 **같다.** 승인함의
 * **서버**가 제 `client_secret` 으로 자기를 밝히고, 누구의 것인지는 `sub` 로 적어
 * 보낸다. 🔴 문 여섯을 베끼지 않고 `authorizeSiteRequest` 를 그대로 부르는 까닭도
 * 그 파일에 적힌 그대로다 — 베끼면 한쪽만 고치는 날 조용히 갈라지고, **갈라진 것이
 * 보안 판정이면 증상이 없어** 아무도 모른다.
 *
 * ── 🔴 왜 GET 이 아니라 POST 인가 ─────────────────────────────────────────
 * 세 집에 묻는 길은 GET 인데 이 길은 POST 다. 뒤집힌 것이 아니라 **싣는 것이 다르다**:
 * 이 요청에는 `sub`(사람 번호)가 실린다. 주소에 실으면 접근 로그·프록시 로그에
 * 그대로 남는다 — 알림·결재함 통로 셋이 같은 까닭으로 POST 다. 세 집에 묻는 길은
 * 사람을 **토큰 안에서만** 나르므로 주소에 실릴 것이 기간 둘뿐이라 GET 이다.
 *
 * ── 🔴 기간은 **문 여섯 뒤에** 본다 ───────────────────────────────────────
 * 지움 통로가 열쇠를 여섯 뒤에 보는 것과 같은 판단이다(site-dismissals.ts). 인증을
 * 통과하지 못한 쪽이 기간 검사 결과를 보면, 이 통로가 「**이 글자 모양이 맞나**」를
 * 공짜로 물어보는 도구가 된다.
 *
 * ── 🔴 여기서 400 을 내는 것이 **이 조각의 핵심 중 하나다** ────────────────
 * 날짜 고르개에서 온 `2026-11-01`(시간대 없음)을 그대로 실어 보내면 세 집이
 * **한꺼번에 400** 을 낸다. 그때 승인함에 뜨는 말은 「세 집을 다 못 물었다」가 되어
 * **제 실수를 가리키지 않고**, 사람에게는 「내역이 통째로 비었다」로 보인다.
 * 포털이 같은 정규식으로 먼저 거르면 승인함은 **첫 시도에서** `invalid_period` 를
 * 받는다. 읽는 자리도 글자도 history-period.ts 한 곳에 있다.
 *
 * ── 🔴 이 요청은 「승인함을 열었다」로 치지 **않는다** ─────────────────────
 * 결재함 통로는 이 자리에서 `seen_at` 을 민다 — `/apps` 타일의 빨간 점이 그 값
 * 하나로 꺼지기 때문이다(screen-request.ts). 🔴 **내역은 그 점과 아무 상관이 없다.**
 * 점의 뜻은 「마지막으로 연 뒤에 **새로 올라온 결재**가 있는가」인데, 내역을 보는 것은
 * 이미 끝난 결재를 읽는 일이다. 여기서 밀면 사람이 지난달 내역을 뒤적이는 것만으로
 * 점이 꺼지고, **아직 안 본 새 결재가 묻힌다.**
 *
 * ── 왜 라우트가 아니라 여기인가 ──────────────────────────────────────────
 * 이 통로의 값어치도 **거절이 제대로 되는가** 하나에 달려 있다. 라우트 안에 두면
 * DB 와 서명 키가 붙어 있어 시험이 그 거절들을 돌려 볼 수 없다.
 * ============================================================================
 */

/** 내역을 모으는 일 하나가 문 여섯에 더 붙는다. */
export type ApprovalHistoryDeps<C extends { clientId: string }> = SiteRequestDeps<C> & {
  /**
   * 🔴 **받는 것은 사람 하나와 기간 하나뿐이다.** 부른 시스템이 누구인지는 받지
   * 않는다 — 받아 두면 언젠가 그것으로 답을 바꾸게 되고, 그때부터 「누가 물었나」가
   * 답을 가른다(결재함 통로의 같은 울타리).
   *
   * 🔴 **던지면** 라우트가 503 으로 받는다 — DB 가 죽은 경우다. 모으는 동안의
   * 실패(죽음 · 느림 · 토큰 거절)는 던지지 않고 `sources` 로 돌아온다.
   */
  historyFor(params: {
    userId: string;
    period: ApprovalHistoryPeriod;
  }): Promise<PortalApprovalHistory>;
};

/**
 * 한 번의 요청을 끝까지 판정하고 내역을 내준다. 🔴 **던지지 않는다**(문 여섯은
 * 무엇이 와도 값을 돌려주고, 기간 읽기도 그렇다). 남은 하나는 `deps.historyFor` 뿐이다.
 *
 * 🔴 답에는 **`no-store` 가 붙는다**(성공도 거절도). 기간을 바꿔 다시 물었는데 옛
 * 답이 돌아오면 사람은 「고른 기간이 안 먹는다」를 보게 된다.
 */
export async function handleApprovalHistoryRequest<C extends { clientId: string }>(
  request: Request,
  deps: ApprovalHistoryDeps<C>
): Promise<SiteFeedResponse> {
  // 1. 🔴 문 여섯. 거절은 **그대로** 돌려준다 — 손대는 순간 네 통로가 갈라진다.
  const authorized = await authorizeSiteRequest(request, deps);
  if (!authorized.ok) return authorized.response;

  // 2. 🔴 본문은 `authorizeSiteRequest` 가 읽어 넘겨준 것이다. `request.text()` 를
  //    여기서 다시 부르면 **오류가 아니라 빈 문자열**이 온다(저쪽 주석). 그러면
  //    증상이 「sub 은 멀쩡한데 기간만 언제나 없다」가 되고, 그 말은 원인을 전혀
  //    가리키지 않는다.
  const form = new URLSearchParams(authorized.body);
  const period = readApprovalHistoryPeriod({ from: form.get("from"), to: form.get("to") });

  if (!period.ok) {
    return reject(
      400,
      // 🔴 **세 집이 쓰는 글자 그대로다.** 포털이 제 말을 지어 쓰면 승인함이
      //    「포털이 거절한 것」과 「저쪽 집이 거절한 것」을 가르지 못한다.
      APPROVAL_HISTORY_PERIOD_ERROR,
      // 🔴 **무엇을 고쳐야 하는지가 들어 있어야 한다.** 이 말이 없으면 붙이는 쪽은
      //    400 을 받고도 날짜 고르개의 글자가 문제인 줄 모른다 — 가장 흔한 실수가
      //    「날짜만 보내기」와 「+09:00 을 그대로 싣기」 둘이다.
      "from·to 는 시간대가 붙은 ISO 8601 이어야 합니다(예: 2026-11-01T00:00:00.000Z). 날짜만 보내거나 +09:00 을 인코딩 없이 실으면 읽을 수 없습니다.",
      "invalid_period"
    );
  }

  // 3. 모은다. 🔴 한 집이 죽어도 던지지 않고 `sources`·`degraded` 로 말한다
  //    (history-gather.ts). 던지는 경우는 DB 가 죽은 때뿐이고 라우트가 503 으로 받는다.
  const body = await deps.historyFor({
    userId: authorized.subject,
    period: period.period,
  });

  return { status: 200, body, headers: NO_STORE };
}
