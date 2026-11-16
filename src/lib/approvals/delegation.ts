/**
 * ============================================================================
 * 결재권 위임 — 순수 규칙
 * ============================================================================
 * DB 도 요청도 여기서 만지지 않는다. **받은 값을 보고 답만 한다.** 그래서
 * `server-only` 를 물지 않고, 시험이 그대로 끌어와 돌릴 수 있다(이 저장소의 시험은
 * 전부 이 층에 붙는다).
 *
 * 표는 `approval_delegations`(db/schema/approval-delegations.ts)다. **왜 포털에
 * 두는가 · 왜 `scope` 칸이 없는가**는 그 표 머리말에 적혀 있다.
 *
 * ── 🔴 열쇠는 포털 `users.id` 다. 그리고 그것이 곧 `sub` 다 ──────────────
 * 포털에서는 둘이 **같은 값**이다 — `users.id` 가 그대로 ID 토큰의 `sub` 가 되어
 * 각 시스템에 전달된다. 그래서 아래 함수들은 받은 줄의 `…UserId` 를 그대로
 * 내보내고, 받는 쪽은 그것을 `sub` 로 읽으면 된다.
 *
 * 🔴 **A/S 의 같은 함수에 이 값을 넘기면 안 된다.** 저쪽은 제 안의 `users.id`(uuid)
 * 로 돌아서, 포털 번호를 넘기면 **오류 없이 영원히 빈 답**을 준다. 변환은 저쪽이
 * `users.sso_subject` 로 한다(설계 C-3). 🔵 재고관리는 열쇠가 이미 `sub` 라 바꿀
 * 것이 없다.
 *
 * ── 🔴 방향이 둘이다. 어느 쪽을 묻는지 먼저 가려라 ──────────────────────
 * 「내가 누구를 대신하나」(`delegatorUserIdsFor`)와 「나를 누가 대신하나」
 * (`actingDelegateUserIdsFor`)는 **거르는 칸이 반대**다. 섞어 쓰면 오류 없이 빈 목록이
 * 돌아오므로 이름에 방향을 적어 둔다.
 *
 * 🔵 앞의 것만 **인가**에 쓰인다(`actingApproverSubjects`). 뒤의 것은 「결재가 생겼을
 * 때 알림을 받을 사람」을 넓히는 자리 전용이고, 지금은 부르는 자리가 없다 — 조각 5·6
 * 에서 쓰려고 **함께** 지어 둔다. 규칙을 나중에 한 벌 더 적게 되면 두 벌이 갈라진다.
 * ============================================================================
 */

/**
 * 판정이 위임 한 줄에서 보는 것 — **그게 전부다.**
 *
 * 🔵 사유·만든 사람·이름은 여기 없다. **판정에 쓰이지 않기** 때문이다. 사람에게 보여
 * 줄 값과 판정에 필요한 값을 한 타입에 섞으면, 판정만 필요한 조회(결재 때마다 도는
 * 그 조회)가 쓰지도 않을 칸과 조인 넷을 함께 끌고 다니게 된다.
 */
export type ApprovalDelegationPeriod = {
  /** 결재권을 맡긴 사람의 포털 `users.id`(= 그 사람의 `sub`). */
  delegatorUserId: string;
  /** 대신 눌러 줄 사람의 포털 `users.id`. */
  delegateUserId: string;
  startsAt: Date;
  endsAt: Date;
  /**
   * 되돌렸으면 그 시각. 아직 살아 있으면 `null`. 🔴 줄을 지우는 길은 없다(표 쪽 주석).
   *
   * 🔴 **되돌린 사람은 여기 없다.** 판정에 쓰이지 않기 때문이고, 없어도 안전한 까닭은
   * **표가 두 칸을 짝으로 묶어 두기** 때문이다(`approval_delegations_revocation_metadata`
   * CHECK). 둘 중 하나만 적힌 줄은 DB 가 아예 받아 주지 않으므로, 이 층은 시각 한
   * 칸만 보고도 「되돌렸나」에 틀리지 않게 답할 수 있다.
   */
  revokedAt: Date | null;
};

/**
 * 이 위임이 **지금 살아 있는가** — 되돌리지 않았고, 지금이 그 기간 안인가.
 *
 * ── 🔴 끝은 포함하지 않는다 (반열린 구간 `[starts_at, ends_at)`) ─────────
 * `starts_at <= now < ends_at` 이다. 끝을 포함하면 **한 위임이 끝나는 바로 그 순간에
 * 다음 위임이 시작할 때 둘 다 유효한 순간**이 생긴다. 그 1밀리초에 결재가 들어오면
 * 「누구의 권한으로 눌렀나」가 둘이 되고, 나중에 그 건을 설명할 수 없다. 기간을
 * 잇대어 적는 것은 사람이 실제로 하는 일이라(출장이 끝나는 날 다른 사람에게 다시
 * 맡긴다) 드문 경우도 아니다.
 *
 * 🔵 그래서 「11월 30일까지」를 적을 때 `ends_at` 은 **12월 1일 0시**다. 그 환산은
 * 화면(조각 2)의 몫이고, 이 층은 받은 시각을 그대로 믿는다.
 *
 * ── 🔴 견주는 것은 **epoch ms** 다 ─────────────────────────────────────
 * `Date` 끼리 `<` 로 견주면 되기는 하지만, 글자나 시간대를 거치는 순간 틀린다. 밀리초
 * 하나로 좁혀 두면 **시간대 변환 버그가 들어올 자리 자체가 없다**(A/S 의 같은 판정이
 * 같은 까닭으로 같은 모양이다).
 *
 * 🔴 **되돌린 줄은 기간 안이어도 거짓이다.** 되돌리기가 기간을 줄여 적는 것이 아니라
 * 칸 하나에 시각을 적는 것이라서, 기간만 보면 되돌린 뒤에도 계속 참이 된다.
 */
export function isActiveDelegation(delegation: ApprovalDelegationPeriod, now: Date): boolean {
  if (delegation.revokedAt !== null) return false;
  const at = now.getTime();
  return delegation.startsAt.getTime() <= at && at < delegation.endsAt.getTime();
}

/**
 * 이 사람이 **지금 누구를 대신할 수 있나** — 결재권자들의 포털 `users.id`.
 *
 * @param delegations 볼 위임 줄들. 순서가 뒤섞여 있어도 되고, 이 사람과 상관없는 줄이
 *   섞여 있어도 된다 — 걸러 내는 일을 부르는 쪽에 떠넘기지 않는다.
 * @param delegateUserId 「지금 누르려는 사람」의 포털 `users.id`.
 * @param now 지금 시각.
 *
 * ── 🔴 이어 붙이지 않는다. 위임은 **한 겹**이다 ─────────────────────────
 * A→B 와 B→C 가 둘 다 살아 있어도 **C 는 A 의 결재권을 얻지 못한다.** 이 함수는 받은
 * 목록을 한 번 훑을 뿐, 자기가 돌려준 id 를 다시 `delegateUserId` 로 넣어 되풀이하지
 * 않는다. 까닭이 둘이다:
 *
 *  1. **A 는 C 를 모른다.** A 가 맡긴 사람은 B 뿐인데, B 가 또 맡기는 순간 A 의
 *     결재권이 A 가 동의한 적 없는 사람에게 넘어간다. 결재는 「누가 승인했나」가 곧
 *     근거라, 그 근거가 무너진다.
 *  2. **고리가 생긴다.** A→B, B→A 가 함께 있으면 이어 붙이기는 끝나지 않는다. 깊이
 *     제한을 두는 길도 있지만 그 숫자에 뜻을 붙일 방법이 없다(왜 2단계는 되고 3단계는
 *     안 되는가).
 *
 * 🔵 **한 사람이 둘 이상에게서 위임받는 것은 막지 않는다** — 두 사람이 동시에 자리를
 * 비울 수 있다. 그때는 결재권자 번호가 여럿 돌아오고, 그 사람은 그 여럿의 차례를 모두
 * 누를 수 있다.
 *
 * 🔵 같은 결재권자가 **겹치는 기간으로 여러 줄** 적혀 있어도 번호는 **한 번만**
 * 돌려준다(표가 겹침을 막지 않는다 — 표 쪽 주석). 받는 쪽이 이 값을 「누구의 차례를
 * 볼까」의 조건으로 쓰므로, 겹친 채 넘기면 같은 건이 목록에 두 번 뜬다. 차례는
 * **목록에서 처음 나온 순서**다 — 값이 달라지지 않게 정해 둘 뿐, 뜻은 없다.
 */
export function delegatorUserIdsFor(
  delegations: readonly ApprovalDelegationPeriod[],
  delegateUserId: string,
  now: Date
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const delegation of delegations) {
    if (delegation.delegateUserId !== delegateUserId) continue;
    if (!isActiveDelegation(delegation, now)) continue;
    if (seen.has(delegation.delegatorUserId)) continue;
    seen.add(delegation.delegatorUserId);
    out.push(delegation.delegatorUserId);
  }
  return out;
}

/**
 * 이 결재권자를 **지금 누가 대신할 수 있나** — 살아 있는 대리인들의 포털 `users.id`.
 *
 * 🔴 **바로 위 함수와 방향이 반대다.** 그쪽은 「내가 누구를 대신하나」(대리인으로 좁혀
 * 결재권자를 준다)이고, 이쪽은 「나를 누가 대신하나」(결재권자로 좁혀 대리인을 준다)다.
 * 같은 표를 같은 규칙으로 읽지만 **거르는 칸이 반대**라, 섞어 쓰면 오류 없이 빈 목록이
 * 돌아온다 — 그래서 이름에 방향을 적어 둔다.
 *
 * 규칙 넷은 위 함수와 **글자 그대로 같다**: 되돌린 줄 제외 · 끝은 포함하지 않음 ·
 * 중복 없음 · 이어 붙지 않음. 그래서 「살아 있나」는 베껴 적지 않고 `isActiveDelegation`
 * 하나에 맡기고, 여기서는 **방향만** 바꾼다.
 *
 * ── 🔴 이것은 **인가가 아니다** ─────────────────────────────────────────
 * 「누를 수 있나」는 `actingApproverSubjects` 하나가 정한다. 이쪽은 결재가 생겼을 때
 * **알림을 받을 사람**을 넓히는 값이다 — 여기에 한 사람이 더 들어와도 그 사람이 누를
 * 수 있게 되지는 **않는다.** 알림을 이어 붙이면 더 나쁘다: 자격은 없는데 **남의 결재
 * 차례가 왔다는 사실만** 먼저 알게 된다.
 *
 * 🔴 **결재권자 본인은 여기 넣지 않는다.** 아래 `actingApproverSubjects` 가 본인을 맨
 * 앞에 끼워 주는 것과 일부러 다르다 — 부르는 쪽은 결재권자 본인을 이미 손에 들고 있고,
 * 여기서 한 번 더 주면 그쪽이 중복을 걷어 내야 한다. **빈 목록이 정상이고, 그 뜻은
 * 「지금 대신할 사람이 없다」다.**
 */
export function actingDelegateUserIdsFor(
  delegations: readonly ApprovalDelegationPeriod[],
  delegatorUserId: string,
  now: Date
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const delegation of delegations) {
    if (delegation.delegatorUserId !== delegatorUserId) continue;
    if (!isActiveDelegation(delegation, now)) continue;
    if (seen.has(delegation.delegateUserId)) continue;
    seen.add(delegation.delegateUserId);
    out.push(delegation.delegateUserId);
  }
  return out;
}

/**
 * 「지금 이 사람의 자격으로 누를 수 있는 결재자」 전부 — 포털 `sub` 목록.
 *
 * 🔴 **빈 적이 없다** — 맨 앞은 언제나 본인이다. 그래서 타입이 **빈 목록을 허락하지
 * 않는 꼴**이다. 받는 쪽(A/S·재고관리)은 이 목록을 조회 조건에 그대로 넣는데, 빌 수
 * 있으면 `IN ()` 이 되어 **아무도 아무것도 못 누르는데 오류는 나지 않는** 자리가 된다.
 */
export type ActingApproverSubjects = readonly [string, ...string[]];

/**
 * 🔴 **「누를 수 있나」가 두 벌로 적히는 것을 막는 자리다.**
 *
 * ── 🔴 위임은 **넘기는 것이 아니라 늘리는 것**이다 ──────────────────────
 * 본인이 언제나 맨 앞에 남는다. 자리를 비우며 맡겨 둔 사람이 중간에 들어와 직접 눌러도
 * 막히지 않는다 — 막으면 「맡겼더니 내가 못 누른다」가 되고, 그것은 아무도 바란 적 없는
 * 일이다.
 *
 * 🔴 **이 성질이 「못 물었을 때」의 안전장치이기도 하다.** 각 시스템은 3초 안에 포털의
 * 답을 못 받으면 **「위임 없음」으로 보고 그대로 진행한다**(2026-11-16 결정 — 거절하지
 * 않는다). 그때 남는 목록은 본인 하나이므로 **본인의 결재는 멀쩡히 돌아가고 대리인만
 * 막힌다.** 🔴 막히는 쪽이 아무 말도 못 듣는 것이 이 시스템들에서 가장 비싼 결함
 * 모양이라, **부르는 쪽이 눈에 보이는 안내를 띄우기로 했다**(조각 3·4 의 일).
 *
 * ── 🔴 늘어나는 것은 **대리인 자격뿐**이다 ──────────────────────────────
 * 목록에 들어오는 값은 **지금 살아 있는 위임의 결재권자**뿐이다(`delegatorUserIdsFor`).
 * 포털 관리자라고 남의 번호가 여기 들어오지 않는다 — 관리자는 위임을 **세울** 수 있을
 * 뿐, 그것으로 남의 결재를 대신 누르게 되지는 않는다. 두 겹(A→B·B→C)이 안 이어지는
 * 것도 그 함수가 지킨다.
 *
 * @param subject 「지금 누르려는 사람」의 포털 `users.id`(= `sub`).
 */
export function actingApproverSubjects(
  delegations: readonly ApprovalDelegationPeriod[],
  subject: string,
  now: Date
): ActingApproverSubjects {
  return [subject, ...delegatorUserIdsFor(delegations, subject, now)];
}

/* ------------------------------------------------------------------ */
/* 쓰기 판정 — 지정과 되돌리기                                          */
/* ------------------------------------------------------------------ */

/**
 * 거절의 까닭. 🔴 **글자가 아니라 이 코드로 가른다** — 글자는 화면에 보여 줄 말이라
 * 언제든 바뀌고, 바뀐 글자로 분기하는 코드는 바뀐 날 조용히 안 듣는다.
 *
 * 응답 번호로 어떻게 옮기는지는 delegation-request.ts 한 곳에 있다.
 */
export type DelegationFailureCode =
  /** 모양이 틀렸다(빈 값 · 같은 사람 · 읽을 수 없는 일시). */
  | "VALIDATION_ERROR"
  /** 끝이 시작보다 뒤가 아니다. 🔵 모양 문제지만 사람이 가장 자주 내는 것이라 따로 센다. */
  | "INVALID_TIME_RANGE"
  /** 🔴 없는 사람 · 지금 쓸 수 없는 계정. **둘을 가르지 않는다**(아래 주석). */
  | "INVALID_USER"
  /** 세울 자격도 거둘 자격도 없다. */
  | "FORBIDDEN"
  /** 🔴 **맡은 사람이 스스로 거두려 했다.** 아래 `checkDelegationRevocable` 참조. */
  | "DELEGATE_CANNOT_REVOKE"
  /** 그런 위임 줄이 없다. */
  | "NOT_FOUND"
  /** 이미 되돌린 줄이다. */
  | "CONFLICT"
  /** 기간이 이미 끝났다 — 되돌릴 것이 남아 있지 않다. */
  | "DELEGATION_EXPIRED";

/** 판정 하나의 답. 성공에는 할 말이 없다. */
export type DelegationDecision =
  | { ok: true }
  | { ok: false; code: DelegationFailureCode; message: string };

/** 쓰기 하나의 답. 성공하면 그 줄의 번호가 온다. */
export type DelegationWriteResult =
  | { ok: true; id: string }
  | { ok: false; code: DelegationFailureCode; message: string };

function deny(code: DelegationFailureCode, message: string): DelegationDecision {
  return { ok: false, code, message };
}

/**
 * **누가 위임을 세울 수 있나.**
 *
 * 🔴 **본인은 권한과 무관하게 열려 있다.** 좁히면 결재권자가 자기 자리를 못 맡기게
 * 되고, 그러면 자리를 비우는 사람이 **매번 관리자에게 부탁해야** 한다 — 이 기능이
 * 있는 까닭 자체가 사라진다. 남의 결재권을 맡길 때만 포털 관리자인지 본다.
 *
 * 🔴 **「자기를 대리인으로 세우는 것」은 막지 않는다**(2026-10-26 사용자 결정, 포털도
 * 그대로 따른다). 막을 자리는 `created_by_user_id` 가 남기는 **기록**이지 제약이
 * 아니다 — 누가 세웠는지가 줄마다 남으므로 나중에 전부 추려 볼 수 있다.
 * 🔵 표의 `…_different_users` CHECK 는 **다른 이야기**다. 그쪽은 「A 가 A 를
 * 대신한다」는 뜻 없는 줄을 막는다.
 *
 * ── 🔴 포털의 열쇠는 `users.is_portal_admin` 하나다 ────────────────────
 * A/S 는 `users.shipmentRepresentatives` MANAGE 를 빌려 쓰는데, 그것은 **저쪽 저장소의
 * 권한 표**이고 포털에는 그런 표가 없다. 포털이 가진 것은 이 깃발 하나뿐이고, 그
 * 뜻이 바로 「포털 자체를 관리할 수 있는가」다(users.ts). 🔵 새 권한 영역을 만들지
 * 않는 까닭은 저쪽과 같다 — 새로 만들면 **아무에게도 안 켜진 채로 배포**된다.
 */
export function authorizeDelegationCreate(params: {
  /** 실제로 누른 사람의 포털 `users.id`. */
  actorUserId: string;
  /** 누구의 결재권을 맡기는가. */
  delegatorUserId: string;
  /** 그 사람이 포털 관리자인가(`users.is_portal_admin`). */
  actorIsPortalAdmin: boolean;
}): DelegationDecision {
  if (params.actorUserId === params.delegatorUserId) return { ok: true };
  if (params.actorIsPortalAdmin) return { ok: true };
  return deny(
    "FORBIDDEN",
    "결재권자 본인 또는 포털 관리자만 결재권 위임을 지정할 수 있습니다."
  );
}

/**
 * **이 줄을 지금 되돌릴 수 있나.**
 *
 * ── 🔴 「맡은 위임은 스스로 되돌릴 수 없다」를 **서버가** 막는다 ──────────
 * 화면이 단추를 숨기는 것에 기대지 않는다(A/S 도 같다). 맡은 사람이 스스로 자격을
 * 버리는 길을 두면 **맡긴 사람이 모르는 사이에 그 결재가 다시 멈춘다** — 맡긴 쪽은
 * 「맡겨 뒀다」고 믿고 있으므로 아무도 그 건을 보지 않는다. 대리인이 못 하겠다고 하면
 * 맡긴 사람이나 포털 관리자가 거둔다.
 *
 * 🔴 그 경우만 **코드를 따로 둔다**(`DELEGATE_CANNOT_REVOKE`). 「권한 없음」으로
 * 뭉뚱그리면 화면이 「당신은 이것을 거둘 수 없습니다」밖에 말할 수 없는데, 사람이 알아야
 * 할 것은 **누구에게 말해야 하는가**다.
 *
 * ── 차례에 뜻이 있다 ────────────────────────────────────────────────────
 * 상태 둘(되돌림 · 만료)을 **자격보다 먼저** 본다. 자격을 먼저 보면, 맡긴 본인이 이미
 * 끝난 줄의 [되돌리기]를 눌렀을 때 「권한 없음」이 나온다 — 화면을 새로 고치라는 말과
 * 권한 이야기는 전혀 다른 안내다. 🔵 그 대가로 자격 없는 사람도 「이미 철회됨」은 알게
 * 되는데, 여기 들어오는 사람은 **이미 포털에 로그인한 사내 직원**이라 잃는 것이 없다.
 *
 * 🔴 **기간이 끝난 줄은 되돌리지 않는다.** 되돌려도 바뀌는 것이 없으면서 「철회됨」
 * 딱지만 붙고, 그러면 그 줄이 **왜 끝났는지**(기간이 다 돼서인지 사람이 거둬들여서인지)
 * 를 나중에 구별할 수 없다.
 */
export function checkDelegationRevocable(params: {
  delegation: Pick<
    ApprovalDelegationPeriod,
    "delegatorUserId" | "delegateUserId" | "endsAt" | "revokedAt"
  >;
  /** 실제로 누른 사람의 포털 `users.id`. */
  actorUserId: string;
  /** 그 사람이 포털 관리자인가(`users.is_portal_admin`). */
  actorIsPortalAdmin: boolean;
  now: Date;
}): DelegationDecision {
  const { delegation, actorUserId, actorIsPortalAdmin, now } = params;

  if (delegation.revokedAt !== null) {
    return deny("CONFLICT", "이미 철회된 위임입니다. 최신 정보를 다시 불러와 주세요.");
  }
  if (delegation.endsAt.getTime() <= now.getTime()) {
    return deny(
      "DELEGATION_EXPIRED",
      "이미 기간이 끝난 위임입니다. 철회할 것이 남아 있지 않습니다."
    );
  }

  // 맡긴 본인은 언제나 거둬들일 수 있다.
  if (delegation.delegatorUserId === actorUserId) return { ok: true };

  // 🔴 맡은 사람은 **관리자여도** 스스로 거둘 수 없다. 이 줄이 위 문단의 전부다 —
  //    깃발 검사를 먼저 두면 「관리자인 대리인」만 거둘 수 있게 되어, 같은 기능이
  //    사람에 따라 다르게 도는 가장 설명하기 어려운 모양이 된다.
  if (delegation.delegateUserId === actorUserId) {
    return deny(
      "DELEGATE_CANNOT_REVOKE",
      "맡은 결재권은 스스로 되돌릴 수 없습니다. 맡긴 분 또는 포털 관리자에게 요청하세요."
    );
  }

  if (actorIsPortalAdmin) return { ok: true };

  return deny(
    "FORBIDDEN",
    "결재권자 본인 또는 포털 관리자만 결재권 위임을 철회할 수 있습니다."
  );
}
