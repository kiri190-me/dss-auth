import {
  authorizeSiteRequest,
  NO_STORE,
  type SiteFeedResponse,
  type SiteRequestDeps,
} from "@/lib/notifications/site-feed";
import type { ScreenApprovalInbox } from "./screen-gather";

/**
 * ============================================================================
 * 승인함이 「이 사람이 결재할 건」을 물으러 오는 통로 — 판정 전부
 * ============================================================================
 *   POST {포털}/api/integration/approvals
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   sub=<포털 users.id (ID 토큰의 sub)>
 *
 * 방향도 자격증명도 알림 읽기 통로(notifications/site-feed.ts)와 **같다.**
 * 사이트의 서버가 제 `client_secret` 으로 자기를 밝히고, 누구의 것인지는 `sub`
 * 로 적어 보낸다.
 *
 * ── 🔴 문 여섯을 베끼지 않았다 — `authorizeSiteRequest` 를 그대로 부른다 ──
 * 이 방향의 통로는 이제 셋이다: 알림 읽기 · 알림 지움 · 그리고 여기. 셋이
 * **같은 자격증명으로 같은 문 여섯**을 지난다:
 *
 *   ① 주소에 비밀값이 실려 있는가  ② 자격증명이 읽히는가
 *   ③ 본문에 누구인지 적혀 있는가  ④ 그 시스템이 맞는가
 *   ⑤ 그 사람이 쓸 수 있는가      ⑥ 🔴 그 시스템이 그 사람을 볼 수 있는가
 *
 * 베끼면 한쪽만 고치는 날 조용히 갈라지고, **갈라진 것이 보안 판정이면 증상이
 * 없어** 아무도 모른다. site-dismissals.ts 가 같은 까닭으로 같은 함수를 쓴다.
 *
 * ── 🔴 `sub` 로 남의 결재함을 보는 길이 어디서 막히는가 ───────────────────
 * 사이트는 `sub` 에 아무나 적어 보낼 수 있다 — 막을 방법이 없고, 그것을
 * 받아들이는 까닭은 site-feed.ts 맨 위에 길게 적혀 있다. 막는 것은 문 ⑤·⑥ 이다:
 *
 *  · ⑤ 그 사람이 **ACTIVE** 가 아니면 403. 정지·삭제된 계정의 결재는 안 나간다.
 *  · ⑥ 🔴 그 사람이 **부른 시스템에 들어갈 수 없으면** 403. 승인함을 쓸 수 없는
 *    사람의 결재는 승인함이 물어도 안 나간다.
 *
 * 🔴 그리고 **여기서 더 좁혀진다**: 내주는 줄은 포털이 그 사람의 권한대로 고른
 * 시스템에서만 온다(screen-service.ts 의 `listAccessibleClients`). 못 들어가는
 * 시스템에는 묻지도 않으므로, `sub` 를 바꿔 치더라도 그 사람이 **실제로 볼 수
 * 있는 것 이상**은 한 줄도 나오지 않는다.
 *
 * ── 🔵 부른 사이트 자신을 빼는 처리가 없다 ───────────────────────────────
 * 알림 읽기 통로는 부른 사이트의 줄을 빼 준다(되돌기를 막으려고 — site-service.ts).
 * 여기는 뺄 것이 없다: 승인함(`dss-approvals`)에는 결재 통로가 없어 물어볼 곳
 * 목록(sources.ts 의 `APPROVAL_SOURCE_CLIENT_IDS`)에 애초에 들어 있지 않다.
 * 🔴 그래서 `inboxFor` 는 **부른 사이트가 누구인지 받지 않는다** — 받아 두면
 * 언젠가 그것으로 답을 바꾸게 되고, 그때부터 「누가 물었나」가 답을 가른다.
 *
 * ── 왜 라우트가 아니라 여기인가 ──────────────────────────────────────────
 * 이 통로의 값어치도 **거절이 제대로 되는가** 하나에 달려 있다. 라우트 안에
 * 두면 DB 와 서명 키가 붙어 있어 시험이 그 거절들을 돌려 볼 수 없다.
 * ============================================================================
 */

/** 결재함을 모으는 일 하나가 문 여섯에 더 붙는다. */
export type ApprovalInboxDeps<C extends { clientId: string }> = SiteRequestDeps<C> & {
  /**
   * 🔴 **받는 것은 사람 하나뿐이다**(위 「부른 사이트 자신을 빼는 처리가 없다」).
   * 🔴 **던지면** 라우트가 503 으로 받는다 — DB 가 죽은 경우다.
   */
  inboxFor(params: { userId: string }): Promise<ScreenApprovalInbox>;
};

/**
 * 한 번의 요청을 끝까지 판정하고 결재함을 내준다. 🔴 **던지지 않는다**(문 여섯은
 * 무엇이 와도 값을 돌려준다). 남은 하나는 `deps.inboxFor` 뿐이다.
 *
 * 🔴 답에는 **`no-store` 가 붙는다**(성공도 거절도). 종의 30초 캐시와 다른
 * 점이고, 다를 수밖에 없다 — 방금 결재한 건이 승인함에 남아 있으면 그 사람이
 * 다시 누르고 「이미 처리된 건」을 본다.
 */
export async function handleApprovalInboxRequest<C extends { clientId: string }>(
  request: Request,
  deps: ApprovalInboxDeps<C>
): Promise<SiteFeedResponse> {
  // 🔴 문 여섯. 거절은 **그대로** 돌려준다 — 손대는 순간 세 통로가 갈라진다.
  const authorized = await authorizeSiteRequest(request, deps);
  if (!authorized.ok) return authorized.response;

  return {
    status: 200,
    body: await deps.inboxFor({ userId: authorized.subject }),
    headers: NO_STORE,
  };
}
