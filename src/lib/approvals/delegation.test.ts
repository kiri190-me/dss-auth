import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actingApproverSubjects,
  actingDelegateUserIdsFor,
  authorizeDelegationCreate,
  checkDelegationRevocable,
  delegatorUserIdsFor,
  isActiveDelegation,
  type ApprovalDelegationPeriod,
} from "./delegation";

/**
 * ============================================================================
 * 결재권 위임 — 규칙 전부를 여기서 못 박는다
 * ============================================================================
 * 이 판정이 틀리면 생기는 일이 **둘 다 조용하다**:
 *
 *   · 넓게 틀리면 — 남의 결재를 누를 수 있는 사람이 는다. 오류는 안 난다
 *   · 좁게 틀리면 — 맡겨 둔 결재가 그냥 선다. 맡긴 사람은 맡겼다고 믿는다
 *
 * 그래서 아래 시험들은 **「되는 쪽」과 「안 되는 쪽」을 언제나 짝으로** 잰다. 한쪽만
 * 재면 표본이 비어 공짜로 통과하는 시험이 된다(규칙을 지워도 초록이 뜬다).
 * ============================================================================
 */

/** 🔴 값은 전부 가짜다. 실제 사람 번호를 시험에 넣지 않는다. */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const NOW = new Date("2026-11-16T03:00:00.000Z");

function period(over: Partial<ApprovalDelegationPeriod> = {}): ApprovalDelegationPeriod {
  return {
    delegatorUserId: A,
    delegateUserId: B,
    startsAt: new Date("2026-11-16T00:00:00.000Z"),
    endsAt: new Date("2026-11-20T00:00:00.000Z"),
    revokedAt: null,
    ...over,
  };
}

// ───────────────────────────────────────────── 살아 있나 — 반열린 구간

test("기간 안이면 살아 있다 — 이 시험이 아래 시험들의 표본이 비지 않았음을 보인다", () => {
  assert.equal(isActiveDelegation(period(), NOW), true);
});

test("🔴 시작하는 **그 순간**은 포함한다", () => {
  const starts = new Date("2026-11-16T00:00:00.000Z");
  assert.equal(isActiveDelegation(period({ startsAt: starts }), starts), true);
});

test("🔴 끝나는 **그 순간**은 포함하지 않는다 — 반열린 구간 [starts, ends)", () => {
  const ends = new Date("2026-11-20T00:00:00.000Z");
  assert.equal(isActiveDelegation(period({ endsAt: ends }), ends), false);
  // 1밀리초 앞은 아직 살아 있다. 🔵 이 짝이 없으면 「언제나 거짓」인 함수도 통과한다.
  assert.equal(
    isActiveDelegation(period({ endsAt: ends }), new Date(ends.getTime() - 1)),
    true
  );
});

test("🔴 잇대어 적은 두 위임이 한순간도 겹치지 않는다", () => {
  const 경계 = new Date("2026-11-20T00:00:00.000Z");
  const 앞 = period({ delegateUserId: B, endsAt: 경계 });
  const 뒤 = period({ delegateUserId: C, startsAt: 경계, endsAt: new Date("2026-11-25T00:00:00.000Z") });

  // 경계의 그 순간에 살아 있는 것은 **뒤 하나뿐**이다. 둘 다 살아 있으면 그 1밀리초에
  // 들어온 결재를 「누구의 권한으로 눌렀나」로 설명할 수 없다.
  assert.equal(isActiveDelegation(앞, 경계), false);
  assert.equal(isActiveDelegation(뒤, 경계), true);
});

test("아직 시작 안 한 줄은 죽은 줄이다", () => {
  const future = period({
    startsAt: new Date("2026-12-01T00:00:00.000Z"),
    endsAt: new Date("2026-12-05T00:00:00.000Z"),
  });
  assert.equal(isActiveDelegation(future, NOW), false);
  assert.deepEqual(delegatorUserIdsFor([future], B, NOW), []);
});

test("🔴 되돌린 줄은 **기간 안이어도** 죽은 줄이다", () => {
  const revoked = period({ revokedAt: new Date("2026-11-16T01:00:00.000Z") });
  // 되돌리기는 기간을 줄여 적는 것이 아니다 — 기간만 보면 계속 참이 된다.
  assert.equal(revoked.startsAt.getTime() <= NOW.getTime(), true, "표본이 기간 안이다");
  assert.equal(NOW.getTime() < revoked.endsAt.getTime(), true, "표본이 기간 안이다");
  assert.equal(isActiveDelegation(revoked, NOW), false);
});

// ───────────────────────────────────────────── 내가 누구를 대신하나

test("🔴 본인이 **맨 앞**이고, 뒤에 결재권자가 붙는다", () => {
  const subs = actingApproverSubjects([period()], B, NOW);
  assert.deepEqual([...subs], [B, A]);
  assert.equal(subs[0], B, "맨 앞은 언제나 본인이다");
});

test("🔴 위임이 하나도 없어도 **빈 적이 없다** — 본인 하나는 남는다", () => {
  const subs = actingApproverSubjects([], B, NOW);
  assert.deepEqual([...subs], [B]);
  // 🔴 빌 수 있으면 받는 쪽의 `IN ()` 이 되어, 아무도 아무것도 못 누르는데 오류는
  //    나지 않는 자리가 된다. 못 물었을 때 「위임 없음」으로 보는 쪽도 이 성질에
  //    기대어 **본인의 결재만은 돌아간다.**
  assert.equal(subs.length, 1);
});

test("🔴 **이어 붙이지 않는다** — A→B, B→C 라도 C 는 A 를 못 얻는다", () => {
  const rows = [
    period({ delegatorUserId: A, delegateUserId: B }),
    period({ delegatorUserId: B, delegateUserId: C }),
  ];

  // 🔵 표본이 살아 있다는 것부터 보인다 — 둘 다 죽어 있으면 아래 단언이 공짜다.
  assert.deepEqual([...actingApproverSubjects(rows, B, NOW)], [B, A], "B 는 A 를 얻는다");

  const forC = actingApproverSubjects(rows, C, NOW);
  assert.deepEqual([...forC], [C, B], "C 가 얻는 것은 B 뿐이다");
  assert.equal(forC.includes(A), false, "🔴 C 는 A 의 결재권을 얻지 못한다");
});

test("🔴 고리(A→B, B→A)가 있어도 끝난다", () => {
  const rows = [
    period({ delegatorUserId: A, delegateUserId: B }),
    period({ delegatorUserId: B, delegateUserId: A }),
  ];
  assert.deepEqual([...actingApproverSubjects(rows, A, NOW)], [A, B]);
  assert.deepEqual([...actingApproverSubjects(rows, B, NOW)], [B, A]);
});

test("🔴 겹치는 위임 둘이어도 결재권자는 **한 번만** 나온다", () => {
  const rows = [
    period({ startsAt: new Date("2026-11-15T00:00:00.000Z"), endsAt: new Date("2026-11-18T00:00:00.000Z") }),
    period({ startsAt: new Date("2026-11-16T00:00:00.000Z"), endsAt: new Date("2026-11-20T00:00:00.000Z") }),
  ];
  // 🔵 둘 다 살아 있는지부터 본다. 한쪽이라도 죽어 있으면 중복 제거를 재는 것이 아니다.
  assert.equal(isActiveDelegation(rows[0], NOW), true);
  assert.equal(isActiveDelegation(rows[1], NOW), true);

  assert.deepEqual([...actingApproverSubjects(rows, B, NOW)], [B, A]);
});

test("두 사람에게서 동시에 위임받으면 둘 다 나온다 — 차례는 목록에서 처음 나온 순서", () => {
  const rows = [
    period({ delegatorUserId: C, delegateUserId: B }),
    period({ delegatorUserId: A, delegateUserId: B }),
  ];
  assert.deepEqual([...actingApproverSubjects(rows, B, NOW)], [B, C, A]);
});

test("상관없는 줄이 섞여 있어도 걸러 낸다 — 거르는 일을 부르는 쪽에 떠넘기지 않는다", () => {
  const rows = [period({ delegatorUserId: C, delegateUserId: D }), period()];
  assert.deepEqual([...actingApproverSubjects(rows, B, NOW)], [B, A]);
});

// ───────────────────────────────────────────── 나를 누가 대신하나 (방향이 반대)

test("🔴 방향이 반대다 — 결재권자로 좁히면 대리인이 나온다", () => {
  const rows = [period({ delegatorUserId: A, delegateUserId: B })];
  assert.deepEqual(actingDelegateUserIdsFor(rows, A, NOW), [B], "A 를 대신하는 사람은 B");
  // 🔴 섞어 쓰면 **오류 없이 빈 목록**이 돌아온다. 그래서 이름에 방향을 적어 둔다.
  assert.deepEqual(actingDelegateUserIdsFor(rows, B, NOW), []);
  assert.deepEqual(delegatorUserIdsFor(rows, A, NOW), []);
});

test("🔴 이쪽에는 **본인이 끼지 않는다** — 빈 목록이 정상이고 뜻은 「대신할 사람이 없다」", () => {
  assert.deepEqual(actingDelegateUserIdsFor([], A, NOW), []);
});

test("🔴 알림도 이어 붙지 않는다 — A→B, B→C 에서 A 를 대신하는 사람은 B 뿐", () => {
  const rows = [
    period({ delegatorUserId: A, delegateUserId: B }),
    period({ delegatorUserId: B, delegateUserId: C }),
  ];
  assert.deepEqual(actingDelegateUserIdsFor(rows, A, NOW), [B]);
});

// ───────────────────────────────────────────── 누가 세울 수 있나

test("본인은 권한과 무관하게 제 결재권을 맡길 수 있다", () => {
  const decision = authorizeDelegationCreate({
    actorUserId: A,
    delegatorUserId: A,
    actorIsPortalAdmin: false,
  });
  assert.equal(decision.ok, true);
});

test("🔴 남의 결재권은 **포털 관리자만** 맡길 수 있다", () => {
  const 거절 = authorizeDelegationCreate({
    actorUserId: C,
    delegatorUserId: A,
    actorIsPortalAdmin: false,
  });
  assert.equal(거절.ok, false);
  assert.equal(거절.ok === false && 거절.code, "FORBIDDEN");

  const 허용 = authorizeDelegationCreate({
    actorUserId: C,
    delegatorUserId: A,
    actorIsPortalAdmin: true,
  });
  assert.equal(허용.ok, true);
});

// ───────────────────────────────────────────── 누가 되돌릴 수 있나

function revocable(over: {
  actorUserId: string;
  actorIsPortalAdmin?: boolean;
  revokedAt?: Date | null;
  endsAt?: Date;
}) {
  return checkDelegationRevocable({
    delegation: {
      delegatorUserId: A,
      delegateUserId: B,
      endsAt: over.endsAt ?? new Date("2026-11-20T00:00:00.000Z"),
      revokedAt: over.revokedAt ?? null,
    },
    actorUserId: over.actorUserId,
    actorIsPortalAdmin: over.actorIsPortalAdmin ?? false,
    now: NOW,
  });
}

test("맡긴 본인은 언제나 거둬들일 수 있다", () => {
  assert.equal(revocable({ actorUserId: A }).ok, true);
});

test("🔴 **맡은 위임은 스스로 되돌릴 수 없다** — 서버가 막는다", () => {
  const decision = revocable({ actorUserId: B });
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.code, "DELEGATE_CANNOT_REVOKE");
  // 🔴 「누구에게 말해야 하는가」가 글에 들어 있어야 한다. 없으면 대리인은 막힌 채로
  //    아무것도 할 수 없다.
  assert.match(
    decision.ok === false ? decision.message : "",
    /맡긴 분 또는 포털 관리자/
  );
});

test("🔴 맡은 사람은 **포털 관리자여도** 스스로 되돌릴 수 없다", () => {
  // 깃발 검사를 먼저 두면 「관리자인 대리인」만 거둘 수 있게 되어, 같은 기능이 사람에
  // 따라 다르게 도는 가장 설명하기 어려운 모양이 된다.
  const decision = revocable({ actorUserId: B, actorIsPortalAdmin: true });
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.code, "DELEGATE_CANNOT_REVOKE");
});

test("포털 관리자는 남의 위임을 거둬들일 수 있다", () => {
  assert.equal(revocable({ actorUserId: C, actorIsPortalAdmin: true }).ok, true);
  const 거절 = revocable({ actorUserId: C, actorIsPortalAdmin: false });
  assert.equal(거절.ok, false);
  assert.equal(거절.ok === false && 거절.code, "FORBIDDEN");
});

test("🔴 이미 되돌린 줄은 다시 되돌리지 않는다 — 맡긴 본인이어도", () => {
  const decision = revocable({ actorUserId: A, revokedAt: new Date("2026-11-16T01:00:00.000Z") });
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.code, "CONFLICT");
});

test("🔴 기간이 끝난 줄은 되돌리지 않는다 — 「왜 끝났나」를 구별할 수 있어야 한다", () => {
  const ended = new Date("2026-11-10T00:00:00.000Z");
  const decision = revocable({ actorUserId: A, endsAt: ended });
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.code, "DELEGATION_EXPIRED");
});

test("🔴 끝나는 **그 순간**에는 이미 되돌릴 것이 없다 — 판정과 같은 경계다", () => {
  const decision = revocable({ actorUserId: A, endsAt: NOW });
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.code, "DELEGATION_EXPIRED");
  // 1밀리초 뒤까지는 살아 있다. 🔵 이 짝이 없으면 경계가 어느 쪽인지 재지 못한다.
  assert.equal(revocable({ actorUserId: A, endsAt: new Date(NOW.getTime() + 1) }).ok, true);
});

test("🔴 상태를 자격보다 **먼저** 본다 — 끝난 줄에 「권한 없음」이 나오면 안내가 틀린다", () => {
  const decision = revocable({
    actorUserId: C,
    actorIsPortalAdmin: false,
    endsAt: new Date("2026-11-10T00:00:00.000Z"),
  });
  assert.equal(decision.ok === false && decision.code, "DELEGATION_EXPIRED");
});
