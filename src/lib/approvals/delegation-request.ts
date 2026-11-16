import {
  authorizeSiteRequest,
  MAX_SUBJECT_LENGTH,
  NO_STORE,
  reject,
  type SiteFeedResponse,
  type SiteRequestDeps,
} from "@/lib/notifications/site-feed";
import type { ActingApproverSubjects, DelegationFailureCode, DelegationWriteResult } from "./delegation";

/**
 * ============================================================================
 * 결재권 위임 통로 — 요청을 읽고 판정하는 전부
 * ============================================================================
 *   POST {포털}/api/integration/delegations
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   sub=<포털 users.id (ID 토큰의 sub)>&action=<acting|list|create|revoke>&…
 *
 * 방향도 자격증명도 앞의 통로들과 **같다**(알림 읽기·지움·확인·결재함·결재 생성).
 * 사이트의 서버가 제 `client_secret` 으로 자기를 밝히고, 누구의 것인지는 `sub` 로
 * 적어 보낸다. 그래서 문 여섯을 **베끼지 않고** `authorizeSiteRequest` 를 그대로
 * 부른다 — 베끼면 한쪽만 고치는 날 조용히 갈라지고, **갈라진 것이 보안 판정이면
 * 증상이 없어** 아무도 모른다(notifications/site-feed.ts 머리말).
 *
 * ── 🔴 `sub` 는 **누구의 자격으로 묻는가**다. 네 갈래 모두 같다 ───────────
 * `acting` 은 「이 사람이 지금 누구를 대신할 수 있나」, `list` 는 「이 사람이 볼 수
 * 있는 위임」, `create`·`revoke` 는 「이 사람이 누른다」. 🔴 그래서 `sub` 가 바뀌면
 * **답도 자격도 함께 바뀐다** — 사이트가 `sub` 에 아무나 적어 보낼 수 있다는 사실이
 * 여기서는 쓰기까지 닿는다. 막는 것은 앞의 통로들과 같은 문 ⑤·⑥ 이고, 그것을
 * 받아들이는 까닭도 같다(site-feed.ts 맨 위의 ⚠️ 문단). 🔵 여기서 더 좁혀지는 것이
 * 하나 있다: **남의 결재권을 맡기거나 거두는 일은 포털 관리자만** 할 수 있고, 그
 * 판정은 `sub` 가 가리키는 사람의 `users.is_portal_admin` 으로 한다(delegation.ts).
 *
 * ── 🔴 넷 다 POST 다. GET 을 열지 않는다 ─────────────────────────────────
 * `acting` 과 `list` 는 읽기지만 주소에 `sub` 를 실으면 **사람 번호가 접근 로그·프록시
 * 로그에 그대로 남는다.** 결재함 통로(approvals/route.ts)와 같은 까닭이고, 길이 둘이면
 * 둘 다 지켜야 한다.
 *
 * ── 🔴 못 물었을 때는 **「위임 없음」이다. 거절이 아니다** (2026-11-16 결정) ──
 * 각 시스템은 이 통로에 **3초** 상한을 걸고 묻는다. 넘거나 깨지면 **위임이 없는
 * 것으로 보고 결재를 그대로 진행한다.** 본인 번호는 언제나 목록 맨 앞에 있으므로
 * (`actingApproverSubjects`) **본인의 결재는 멀쩡히 돌아가고 대리인만 막힌다.**
 *
 * 🔴 **그래서 부르는 쪽이 눈에 보이는 안내를 띄우기로 했다.** 「조용히 막힌다」가 이
 * 시스템들에서 가장 비싼 결함 모양이다 — 대리인은 자기가 왜 못 누르는지 알 길이 없고,
 * 맡긴 사람은 맡겨 뒀다고 믿는다. 🔵 그 안내는 **이 통로의 일이 아니다**(조각 3·4).
 * 여기서 할 수 있는 것은 **까닭을 분명히 돌려주는 것**뿐이라, 거절은 번호와 코드를
 * 함께 싣는다(아래 `statusForFailure`).
 *
 * ── 왜 라우트가 아니라 여기인가 ──────────────────────────────────────────
 * 앞의 통로들과 같다. 이 통로의 값어치도 **거절이 제대로 되는가** 하나에 달려 있고,
 * 라우트 안에 두면 DB 가 붙어 있어 시험이 그 거절들을 돌려 볼 수 없다. 라우트는
 * 이것을 진짜 함수로 채우는 껍데기다.
 * ============================================================================
 */

/** 이 통로가 받는 일 넷. 🔴 **모르는 값은 조용히 넘기지 않고 400 이다**(아래). */
export const DELEGATION_ACTIONS = ["acting", "list", "create", "revoke"] as const;
export type DelegationAction = (typeof DELEGATION_ACTIONS)[number];

/**
 * 사유 길이 상한. A/S 의 같은 칸과 **같은 2000자**다 — 두 곳에 적는 사람이 한쪽에서만
 * 잘리는 일을 겪지 않게.
 */
export const MAX_DELEGATION_REASON_LENGTH = 2000;

/**
 * 화면이 한 줄을 그리는 데 필요한 전부. 조회가 돌려주는 모양이고, 이 층이 글자로
 * 바꿔 내보낸다.
 *
 * 🔵 이름을 함께 싣는 까닭은 **승인함이 알 길이 없기** 때문이다 — 포털이 사람 명부의
 * 주인이고, 승인함이 가진 것은 `sub` 뿐이다. 그 이상은 싣지 않는다(이메일·부서는 이
 * 화면에 쓸 곳이 없다).
 */
export type ApprovalDelegationRow = {
  id: string;
  delegatorUserId: string;
  delegatorName: string;
  delegateUserId: string;
  delegateName: string;
  startsAt: Date;
  /** 🔴 이 순간은 포함하지 않는다(반열린 구간). */
  endsAt: Date;
  /** 선택 입력이라 **빈 글자**가 정상이다 — 널이 아니다. */
  reason: string;
  createdByUserId: string;
  createdByName: string;
  createdAt: Date;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  revokedByName: string | null;
};

/**
 * 망으로 나가는 한 줄.
 *
 * 🔴 **칸 이름이 `…Sub` 다.** 받는 쪽(승인함·각 시스템)이 사람을 가리키는 말이 `sub`
 * 하나뿐이라 그 말로 적는다. 포털에서는 `users.id` 와 **같은 값**이지만, 저쪽에서는
 * 같지 않다 — A/S 는 이 값을 제 `users.sso_subject` 로 한 번 바꿔야 쓴다.
 *
 * 🔴 **시각은 ISO 글자다.** `Date` 를 그대로 실으면 JSON 직렬화가 알아서 바꿔 주기는
 * 하지만, 그러면 **나가는 모양이 코드에 안 적혀 있게** 된다. 받는 쪽은 이 타입을 보고
 * 짜는데, 그 모양을 바꾸는 것이 우리 코드가 아니라 런타임이면 언젠가 말없이 달라진다.
 */
export type WireDelegation = {
  id: string;
  delegatorSub: string;
  delegatorName: string;
  delegateSub: string;
  delegateName: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdBySub: string;
  createdByName: string;
  createdAt: string;
  revokedAt: string | null;
  revokedBySub: string | null;
  revokedByName: string | null;
};

/** 한 줄을 망으로 나갈 모양으로 바꾼다. 🔴 **여기 한 곳에서만 바꾼다.** */
export function toWireDelegation(row: ApprovalDelegationRow): WireDelegation {
  return {
    id: row.id,
    delegatorSub: row.delegatorUserId,
    delegatorName: row.delegatorName,
    delegateSub: row.delegateUserId,
    delegateName: row.delegateName,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
    createdBySub: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBySub: row.revokedByUserId,
    revokedByName: row.revokedByName,
  };
}

/** 「모두의 위임」이 돌려주는 것. 🔵 살아 있는 줄에는 상한이 없다(조회 쪽 주석). */
export type AllDelegationsView = {
  live: ApprovalDelegationRow[];
  finished: ApprovalDelegationRow[];
  /** 끝난 줄이 상한보다 많았다. 화면이 「최근 N건만」을 말해 줘야 한다. */
  finishedTruncated: boolean;
  /** 화면이 N 을 글자로 박지 않게 함께 내보낸다. */
  finishedLimit: number;
};

/**
 * 🔴 거절이 **빈 목록이 아니라 `ok: false`** 다. 빈 목록으로 돌려주면 「권한이 없다」와
 * 「아직 아무도 안 맡겼다」가 같은 값이 되고, 화면은 둘을 구별해 말할 수 없다.
 */
export type AllDelegationsResult =
  | { ok: true; view: AllDelegationsView }
  | { ok: false; reason: "FORBIDDEN" };

export type CreateDelegationCommand = {
  /** 🔴 **실제로 누른 사람**(= 요청의 `sub`). 본인인지 관리자인지가 이 값으로 갈린다. */
  actorUserId: string;
  /**
   * 어느 시스템이 보냈나(`clients.client_id`). 감사 기록에 그대로 남는다.
   *
   * 🔵 **판정에는 한 글자도 쓰이지 않는다.** 쓰면 「누가 물었나」가 답을 가르기
   * 시작하고, 그때부터 같은 요청이 보낸 곳에 따라 다르게 돈다. 남기는 까닭은 하나다:
   * 나중에 「이 위임이 어디서 들어왔나」를 물을 자리가 생긴다(지금은 승인함 하나지만
   * 통로는 자격증명만 맞으면 누구에게나 열려 있다).
   */
  clientId: string;
  /** 누구의 결재권인가. 안 보내면 `actorUserId` 자신이다. */
  delegatorUserId: string;
  delegateUserId: string;
  startsAt: Date;
  /** 🔴 이 순간은 포함하지 않는다(반열린 구간). */
  endsAt: Date;
  /** 선택 입력. 안 적었으면 **빈 글자**다 — 이 칸은 널을 받지 않는다. */
  reason: string;
};

export type RevokeDelegationCommand = {
  /** 🔴 **실제로 누른 사람**(= 요청의 `sub`). */
  actorUserId: string;
  /** 어느 시스템이 보냈나. 🔵 판정에는 쓰이지 않는다(위 `clientId` 주석). */
  clientId: string;
  delegationId: string;
};

/**
 * 문 여섯에 **일 넷이 더 붙는다.** 전부 바깥에서 받는다 — 진짜 DB 함수를 여기서
 * 가져오면 시험이 이 판정들을 돌려 볼 수 없다.
 *
 * 🔴 **던지면 라우트가 503 으로 받는다**(DB 가 죽은 경우). 여기서 삼키지 않는다 —
 * 삼키면 「위임이 없다」와 「못 읽었다」가 같은 답이 되고, 부르는 쪽은 둘을 가를 수
 * 없다. 🔵 각 시스템이 못 물었을 때 「위임 없음」으로 보기로 한 것은 **저쪽의**
 * 판단이고(머리말), 포털이 그 판단을 대신해 주면 저쪽은 그런 일이 있었다는 사실조차
 * 모른다.
 */
export type DelegationDeps<C extends { clientId: string }> = SiteRequestDeps<C> & {
  /**
   * 「지금」. 🔴 **한 요청에 하나만 만든다** — 조회 둘이 각자 만들면 그 사이에 끝난
   * 줄이 양쪽에서 빠지거나 양쪽에 들어간다. 🔵 시험이 시계를 고정할 수 있게 받는다.
   */
  now?(): Date;
  /** 「이 사람이 지금 누구를 대신할 수 있나」 — 맨 앞은 언제나 본인이다. */
  actingFor(params: { userId: string; now: Date }): Promise<ActingApproverSubjects>;
  /** 내가 맡긴 것 / 내가 대신하고 있는 것. 끝난 줄도 함께 온다(화면이 딱지를 그린다). */
  listForUser(params: { userId: string }): Promise<{
    given: ApprovalDelegationRow[];
    received: ApprovalDelegationRow[];
  }>;
  /**
   * 🔴 **모두의 위임.** 권한은 **조회 쪽이 제 손으로** 묻고 거절한다 — 여기서 깃발을
   * 보고 갈라서는 안 된다. 화면이나 통로가 가리는 데 그치면, 이 조회를 부르는 **새
   * 자리**가 생기는 날 조용히 다 새어 나간다(A/S 가 2026-10-26 에 같은 자리에서 겪었다).
   */
  listAll(params: { actorUserId: string; now: Date }): Promise<AllDelegationsResult>;
  create(command: CreateDelegationCommand): Promise<DelegationWriteResult>;
  revoke(command: RevokeDelegationCommand): Promise<DelegationWriteResult>;
};

/**
 * 거절의 까닭을 응답 번호로 옮긴다. 🔴 **여기 한 곳에서만 옮긴다** — 부르는 자리마다
 * 적으면 같은 까닭이 통로에 따라 다른 번호로 나간다.
 *
 * 🔴 **없는 사람과 정지된 사람은 둘 다 400 `INVALID_USER` 다.** 갈라 주면 이 통로가
 * **포털 사용자 목록을 묻는 조회 도구**가 된다 — 번호를 하나씩 넣어 보며 400 의 종류를
 * 세면 누가 있고 누가 정지됐는지 알 수 있다. 앞의 통로들이 401·403 을 한 얼굴로
 * 돌려주며 막아 둔 바로 그 조회다(site-feed.ts 의 `forbidden`).
 */
export function statusForFailure(code: DelegationFailureCode): number {
  switch (code) {
    case "VALIDATION_ERROR":
    case "INVALID_TIME_RANGE":
    case "INVALID_USER":
      return 400;
    case "FORBIDDEN":
    case "DELEGATE_CANNOT_REVOKE":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "DELEGATION_EXPIRED":
      return 409;
  }
}

/** 응답 본문의 `error` 값. 🔵 번호와 짝이라 한 곳에서 함께 정한다. */
function errorNameForStatus(status: number): string {
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  return "invalid_request";
}

/**
 * 쓰기·판정의 거절 하나를 응답으로 옮긴다.
 *
 * 🔴 **코드도 함께 싣는다**(`code`). 글자는 사람에게 보여 줄 말이라 언제든 바뀌고,
 * 바뀐 글자로 분기하는 승인함은 바뀐 날 조용히 안 듣는다. 🔵 글자는 **우리 코드가
 * 지은 것**이라 그대로 내보내도 된다 — 저쪽에서 온 글자가 아니다.
 */
function failure(code: DelegationFailureCode, message: string): SiteFeedResponse {
  const status = statusForFailure(code);
  const response = reject(
    status,
    errorNameForStatus(status),
    message,
    `delegation_${code.toLowerCase()}`
  );
  return { ...response, body: { ...(response.body as object), code } };
}

/** 모양이 틀린 요청. 🔵 위와 달리 코드가 없다 — 판정까지 가지도 못한 것이다. */
function badRequest(description: string, logReason: string): SiteFeedResponse {
  return reject(400, "invalid_request", description, logReason);
}

/**
 * 사람 번호 하나를 읽는다. 🔴 **터무니없이 긴 값은 조회하지 않고 거절한다** — 없으면
 * 수 MB 짜리 문자열로 DB 조회를 돌리게 만들 수 있다(site-feed.ts 의 같은 상한).
 */
function readSubject(
  params: URLSearchParams,
  field: string
): { ok: true; value: string } | { ok: false; response: SiteFeedResponse } {
  const value = params.get(field)?.trim() ?? "";
  if (!value) {
    return {
      ok: false,
      response: badRequest(`${field} 가 필요합니다.`, `no_${field}`),
    };
  }
  if (value.length > MAX_SUBJECT_LENGTH) {
    return {
      ok: false,
      response: badRequest(`${field} 가 너무 깁니다.`, `${field}_too_long`),
    };
  }
  return { ok: true, value };
}

/**
 * 한 번의 요청을 끝까지 판정하고 일을 시킨다. 🔴 **판정은 던지지 않는다** — 문 여섯도
 * (`authorizeSiteRequest`) 본문 읽기도 무엇이 와도 값을 돌려준다. 남은 것은 `deps` 의
 * DB 일들뿐이고, 그것이 던지는 경우는 **DB 가 죽은 때**라 라우트가 503 으로 받는다.
 *
 * 🔴 답에는 **`no-store` 가 붙는다**(성공도 거절도). 위임은 **지금 이 순간의 답**이고,
 * 30초만 묵어도 「되돌렸는데 아직 대신 누를 수 있다」가 된다.
 */
export async function handleDelegationRequest<C extends { clientId: string }>(
  request: Request,
  deps: DelegationDeps<C>
): Promise<SiteFeedResponse> {
  // 🔴 문 여섯. 거절은 **그대로** 돌려준다 — 손대는 순간 여섯 통로가 갈라진다.
  const authorized = await authorizeSiteRequest(request, deps);
  if (!authorized.ok) return authorized.response;

  // 🔴 **본문 갈래 검사는 문 여섯 뒤다.** 앞에 두면 자격증명 없이 400 과 401 을 갈라
  //    보는 것만으로 이 통로가 어떤 일을 받는지 짚어 낼 수 있다(지움 통로가 열쇠
  //    검사를 뒤에 둔 것과 같은 까닭).
  // 🔴 본문은 `authorizeSiteRequest` 가 읽어 넘겨준 것이다 — `request.text()` 를 여기서
  //    다시 부르면 **빈 문자열**이 온다(저쪽 주석).
  const params = new URLSearchParams(authorized.body);
  const action = params.get("action")?.trim() ?? "";
  if (!DELEGATION_ACTIONS.includes(action as DelegationAction)) {
    return badRequest(
      `action 이 필요합니다. ${DELEGATION_ACTIONS.join(" · ")} 중 하나를 보내세요.`,
      action ? "unknown_action" : "no_action"
    );
  }

  const now = deps.now?.() ?? new Date();
  const actorUserId = authorized.subject;

  switch (action as DelegationAction) {
    case "acting":
      return acting(deps, actorUserId, now);
    case "list":
      return list(deps, params, actorUserId, now);
    case "create":
      return create(deps, params, actorUserId, authorized.client.clientId);
    case "revoke":
      return revoke(deps, params, actorUserId, authorized.client.clientId);
  }
}

/**
 * 「이 사람이 지금 누구 자격으로 누를 수 있나」 — **각 시스템의 서버가 묻는 것.**
 *
 * 🔴 **맨 앞은 언제나 본인이다**(`actingApproverSubjects`). 받는 쪽은 그 성질에 기대어
 * 이 목록을 조회 조건에 그대로 넣는다 — 빌 수 있으면 「아무도 아무것도 못 누르는데
 * 오류는 안 나는」 자리가 된다.
 */
async function acting<C extends { clientId: string }>(
  deps: DelegationDeps<C>,
  userId: string,
  now: Date
): Promise<SiteFeedResponse> {
  const subs = await deps.actingFor({ userId, now });
  return {
    status: 200,
    body: {
      /** 🔴 `subs[0]` 은 **부른 사람 자신**이다. 뒤에 지금 살아 있는 위임이 붙는다. */
      subs,
      count: subs.length,
    },
    headers: NO_STORE,
  };
}

/**
 * 내가 맡긴 것 / 내가 대신하고 있는 것, 또는 **모두의 것**.
 *
 * 🔴 `scope` 를 틀리게 적으면 **조용히 `mine` 으로 떨어뜨리지 않는다.** 떨어뜨리면
 * 관리자가 `all` 을 오타냈을 때 자기 줄만 보고 「아무도 안 맡겼다」로 읽는다.
 *
 * 🔵 끝난 줄도 함께 돌려준다 — 화면이 네 딱지(활성·예정·만료·철회됨)를 그리려면 죽은
 * 줄도 보여야 하고, 상태는 저장되지 않고 읽을 때 계산되기 때문이다.
 */
async function list<C extends { clientId: string }>(
  deps: DelegationDeps<C>,
  params: URLSearchParams,
  actorUserId: string,
  now: Date
): Promise<SiteFeedResponse> {
  const scope = params.get("scope")?.trim() || "mine";
  if (scope !== "mine" && scope !== "all") {
    return badRequest("scope 는 mine 또는 all 입니다.", "unknown_scope");
  }

  if (scope === "all") {
    const result = await deps.listAll({ actorUserId, now });
    if (!result.ok) {
      // 🔴 거절을 지은 것은 **조회 자신**이다(deps 주석). 여기서는 옮기기만 한다.
      return failure("FORBIDDEN", "모두의 결재권 위임을 볼 수 있는 권한이 없습니다.");
    }
    return {
      status: 200,
      body: {
        scope: "all",
        live: result.view.live.map(toWireDelegation),
        finished: result.view.finished.map(toWireDelegation),
        finishedTruncated: result.view.finishedTruncated,
        finishedLimit: result.view.finishedLimit,
      },
      headers: NO_STORE,
    };
  }

  const mine = await deps.listForUser({ userId: actorUserId });
  return {
    status: 200,
    body: {
      scope: "mine",
      given: mine.given.map(toWireDelegation),
      received: mine.received.map(toWireDelegation),
    },
    headers: NO_STORE,
  };
}

/**
 * 위임 한 줄을 세운다.
 *
 * 🔴 여기서 보는 것은 **모양뿐**이다. 「그 사람이 지금 쓸 수 있는 계정인가」·「누가
 * 세울 수 있나」처럼 **표를 읽어야 답할 수 있는 것**은 mutation 이 제 거래 안에서
 * 본다(A/S 의 validation 층과 같은 경계다).
 *
 * 🔵 「지난 날짜를 적었나」는 보지 않는다. 이미 지나간 기간의 위임은 판정에서 저절로
 * 죽은 줄이 될 뿐이고, 사람이 지난 일을 뒤늦게 기록해 두는 것을 막을 근거가 없다.
 */
async function create<C extends { clientId: string }>(
  deps: DelegationDeps<C>,
  params: URLSearchParams,
  actorUserId: string,
  clientId: string
): Promise<SiteFeedResponse> {
  const delegate = readSubject(params, "delegateSub");
  if (!delegate.ok) return delegate.response;

  // 🔵 안 보내면 **본인의 결재권**이다. 승인함의 보통 쓰임이 그것이고, 남의 것을
  //    맡기는 쪽이 특별한 일이라 그쪽에만 값을 적게 한다.
  const delegatorRaw = params.get("delegatorSub")?.trim() ?? "";
  const delegatorUserId = delegatorRaw || actorUserId;
  if (delegatorUserId.length > MAX_SUBJECT_LENGTH) {
    return badRequest("delegatorSub 가 너무 깁니다.", "delegatorSub_too_long");
  }

  // 🔴 표의 CHECK 둘을 **여기서 먼저** 거른다. 안 거르면 날것의 PostgresError 가
  //    사람에게 그대로 나간다.
  if (delegatorUserId === delegate.value) {
    return failure("VALIDATION_ERROR", "자기 자신을 대리 결재자로 지정할 수 없습니다.");
  }

  const startsAtRaw = params.get("startsAt")?.trim() ?? "";
  const endsAtRaw = params.get("endsAt")?.trim() ?? "";
  if (!startsAtRaw || !endsAtRaw) {
    return badRequest("startsAt 과 endsAt 이 필요합니다.", "no_period");
  }
  const startsAt = new Date(startsAtRaw);
  const endsAt = new Date(endsAtRaw);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    return failure("VALIDATION_ERROR", "시작/종료 일시 형식이 올바르지 않습니다.");
  }
  // 🔴 **같아도 안 된다** — 끝을 포함하지 않으므로 `ends_at = starts_at` 인 줄은 단
  //    한순간도 살아 있지 않은 위임이 되고, 적은 사람은 맡겨 뒀다고 믿는다.
  if (endsAt.getTime() <= startsAt.getTime()) {
    return failure("INVALID_TIME_RANGE", "종료 일시는 시작 일시보다 이후여야 합니다.");
  }

  const reason = (params.get("reason") ?? "").trim();
  if (reason.length > MAX_DELEGATION_REASON_LENGTH) {
    return failure(
      "VALIDATION_ERROR",
      `사유는 ${MAX_DELEGATION_REASON_LENGTH}자까지 적을 수 있습니다.`
    );
  }

  const result = await deps.create({
    actorUserId,
    clientId,
    delegatorUserId,
    delegateUserId: delegate.value,
    startsAt,
    endsAt,
    reason,
  });
  if (!result.ok) return failure(result.code, result.message);

  return { status: 200, body: { id: result.id }, headers: NO_STORE };
}

/**
 * 위임 한 줄을 되돌린다 — 줄은 남고 되돌림 두 칸이 함께 채워진다.
 *
 * 🔴 **「맡은 위임은 스스로 되돌릴 수 없다」는 여기서 판정하지 않는다.** 그 답은 줄을
 * 읽어야 나오므로 mutation 이 **제 거래 안에서** 본다(delegation.ts 의
 * `checkDelegationRevocable`). 여기는 그 거절을 번호로 옮길 뿐이다 — 판정을 두 곳에
 * 적으면 한쪽만 고치는 날 「화면은 막는데 서버는 받아 주는」 짝이 생긴다.
 */
async function revoke<C extends { clientId: string }>(
  deps: DelegationDeps<C>,
  params: URLSearchParams,
  actorUserId: string,
  clientId: string
): Promise<SiteFeedResponse> {
  const delegationId = params.get("delegationId")?.trim() ?? "";
  if (!delegationId) {
    return badRequest("delegationId 가 필요합니다.", "no_delegation_id");
  }
  if (delegationId.length > MAX_SUBJECT_LENGTH) {
    return badRequest("delegationId 가 너무 깁니다.", "delegation_id_too_long");
  }

  const result = await deps.revoke({ actorUserId, clientId, delegationId });
  if (!result.ok) return failure(result.code, result.message);

  return { status: 200, body: { id: result.id }, headers: NO_STORE };
}
