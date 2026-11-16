import "server-only";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvalDelegations, clients, userClientGrants, users } from "@/lib/db/schema";
import { appendAuditLog } from "./audit";
import {
  authorizeDelegationCreate,
  checkDelegationRevocable,
  type DelegationActorAuthority,
  type DelegationFailureCode,
  type DelegationWriteResult,
} from "@/lib/approvals/delegation";
import type {
  CreateDelegationCommand,
  RevokeDelegationCommand,
} from "@/lib/approvals/delegation-request";

/**
 * ============================================================================
 * 결재권 위임 — 지정과 되돌리기
 * ============================================================================
 * 표는 `approval_delegations` 다(schema/approval-delegations.ts).
 *
 * ── 🔴 판정은 여기서 짓지 않는다 ────────────────────────────────────────
 * 「누가 세울 수 있나」·「이 줄을 지금 되돌릴 수 있나」는 순수 함수가 정한다
 * (lib/approvals/delegation.ts 의 `authorizeDelegationCreate` ·
 * `checkDelegationRevocable`). 여기서 하는 일은 **그 판정에 필요한 값을 거래 안에서
 * 읽어다 주고, 통과하면 쓰는 것**뿐이다. 규칙을 여기 한 벌 더 적으면 화면·통로와
 * 갈라지고, 갈라진 쪽이 인가면 **증상이 없다.**
 *
 * ── 🔴 인가의 열쇠가 **둘**이다 (2026-11-16 바뀜) ───────────────────────
 * 전에는 `users.is_portal_admin` 하나였다. 지금은 **보낸 클라이언트에서 그 사람이 갖는
 * 역할이 `ADMIN`** 이거나 그 깃발이면 남의 결재권을 다룰 수 있다. 판정은 베껴 적지 않고
 * `isDelegationAdmin` 하나가 한다(lib/approvals/delegation.ts — 왜 「부른 클라이언트」
 * 기준인지도 거기 적혀 있다).
 *
 * 🔴 **역할도 거래 안에서 읽는다.** 통로가 읽어 넘겨 주는 편이 질의 하나 싸지만, 그러면
 * 이 함수를 **다른 자리에서 부르는 날** 인가의 재료 절반이 바깥에서 들어오게 된다 —
 * 남의 결재권을 세우는 쓰기라 그 자리는 닫아 둔다. 🔵 같은 까닭으로 조회
 * (`listAllApprovalDelegations`)도 제 손으로 읽는다.
 *
 * ── 🔴 겹치는 기간을 막지 않는다 ────────────────────────────────────────
 * 표가 겹침을 정상으로 본다(표 머리말: 두 사람이 동시에 자리를 비울 수 있다). 그래서
 * 겹침 검사도, 그 검사를 지키려고 거는 잠금도 여기엔 없다 — 겹친 줄에서 결재권자가 두
 * 번 나오는 일은 판정 함수가 거른다. **본보기를 옮겨 적다 그 두 조각이 따라 들어오지
 * 않게 할 것.**
 *
 * ── 🔴 사람 행을 잠그지 않는다 — A/S 와 다른 자리다 ──────────────────────
 * A/S 의 같은 mutation 은 맡긴 사람·맡는 사람을 `FOR SHARE` 로 잡는다. 그쪽에는
 * **사람을 지우는 기능**이 있어서, 안 잡으면 삭제가 끝난 직후에 지워진 사람 앞으로 새
 * 위임이 들어갈 수 있기 때문이다. 🔵 **포털에는 사람 행을 지우는 코드가 아예 없다**
 * (2026-11-16 실측: `src` 전체에서 `users` 를 지우는 자리 0건. 손으로 지우려 해도 딸린
 * 기록이 있으면 `restrict` 가 막아 선다). 남은 다툼은 「정지(SUSPENDED)와 동시에
 * 들어온 지정」 하나인데, 위임 판정은 애초에 **맡긴 사람의 계정 상태를 보지 않으므로**
 * (queries 쪽 주석) 잠가서 얻는 것이 없다. 까닭이 사라진 잠금을 베껴 오면 다음 사람이
 * 그 까닭을 찾느라 시간을 쓴다.
 *
 * ── 🔴 감사 기록은 **거래 밖**에서 남는다 ───────────────────────────────
 * 포털의 `appendAuditLog` 는 트랜잭션 핸들을 받지 않고 **실패를 삼킨다**(그 함수의
 * 결정: 「기록 실패가 본래 작업을 실패시키지 않는다」). A/S 는 반대로 거래 안에서
 * 적는다. 그래서 여기서는 **쓰기가 커밋된 뒤에** 부른다 — 거래 안에서 부르면 그
 * insert 는 다른 연결로 나가므로, 거래가 되돌아가도 기록만 남는다. 🔵 반대쪽 대가는
 * 「쓰기는 됐는데 기록이 없는」 경우이고, 그때는 서버 로그에 한 줄이 남는다.
 * ============================================================================
 */

/** 감사 기록의 targetEntity — **표 이름 그대로**(이 저장소의 규약). */
const AUDIT_ENTITY = "approval_delegations";

class DelegationMutationError extends Error {
  result: DelegationWriteResult & { ok: false };
  constructor(result: DelegationWriteResult & { ok: false }) {
    super(result.message);
    this.result = result;
  }
}

function fail(code: DelegationFailureCode, message: string): never {
  throw new DelegationMutationError({ ok: false, code, message });
}

const USER_FIELDS = {
  id: users.id,
  displayName: users.displayName,
  status: users.status,
  isPortalAdmin: users.isPortalAdmin,
} as const;

type PortalUser = {
  id: string;
  displayName: string;
  status: (typeof users.status.enumValues)[number];
  isPortalAdmin: boolean;
};

/**
 * 「지금 쓸 수 있는 계정인가」.
 *
 * 🔴 포털의 사람 상태는 **셋뿐**이다(PENDING · ACTIVE · SUSPENDED). A/S 의 네 조건
 * (안 지워짐·승인됨·활성·안 잠김)을 베껴 오면 포털에 없는 칸을 찾다 멈춘다 — 여기서
 * 그 넷에 해당하는 것은 `status = ACTIVE` 한 줄이다. 승인 대기(PENDING)는 아직 사내
 * 사람으로 확정되지 않은 계정이라 결재권을 맡길 수도, 맡을 수도 없다.
 */
function isUsableUser(user: PortalUser | undefined): user is PortalUser {
  return !!user && user.status === "ACTIVE";
}

/**
 * 거래 핸들. 🔵 drizzle 이 지어 주는 타입이 길고 판마다 달라, **이름으로 끌어다 쓴다** —
 * 손으로 적어 두면 올리는 날 어긋난다.
 */
type DelegationTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 누른 사람과 그 **등급 재료**를 거래 안에서 읽는다.
 *
 * 🔴 **쓰기 둘이 같은 함수를 쓴다.** 한쪽에만 역할을 읽어 두면 「세울 수는 있는데 거둘
 * 수는 없는」 사람이 생기고, 그 어긋남은 오류가 아니라 **그 사람이 포기할 때까지
 * 조용하다.**
 *
 * 🔴 역할은 사람 줄이 아니라 **부여 행**에 붙으므로(`user_client_grants`) 「어느
 * 클라이언트에서」가 함께 있어야 읽힌다. 명령이 들고 오는 것은 **공개 `client_id`**
 * (감사 기록에 남는 그 값)라, 내부 PK 로 가는 길을 `clients` 를 거쳐 한 번 꺾는다.
 * 🔵 통로를 거쳐 온 값은 문 ④ 가 자격증명으로 확인한 클라이언트의 것이다.
 *
 * 🔵 **부여 행이 없으면 역할은 `null`** 이고 그것이 정상이다 — 전 직원 공개 시스템에는
 * 부여 행 자체가 없다. 널을 「아무것도 못 함」으로 읽지 않는 까닭은
 * `isDelegationAdmin` 쪽에 적혀 있다.
 */
async function readActorWithAuthority(
  tx: DelegationTx,
  actorUserId: string,
  clientId: string
): Promise<{ user: PortalUser; authority: DelegationActorAuthority }> {
  const [actor] = await tx
    .select(USER_FIELDS)
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  if (!isUsableUser(actor)) fail("FORBIDDEN", "사용자 정보를 확인할 수 없습니다.");

  const [grant] = await tx
    .select({ role: userClientGrants.role })
    .from(userClientGrants)
    .innerJoin(clients, eq(clients.id, userClientGrants.clientId))
    .where(and(eq(userClientGrants.userId, actor.id), eq(clients.clientId, clientId)))
    .limit(1);

  return {
    user: actor,
    authority: { clientRole: grant?.role ?? null, isPortalAdmin: actor.isPortalAdmin },
  };
}

/**
 * 위임 한 줄을 세운다.
 *
 * 🔴 인자를 **이름 있는 객체로 받는다.** uuid 셋이 줄줄이 늘어선 모양으로 받으면 둘을
 * 바꿔 넣어도 `tsc` 가 아무 말도 하지 않고, 바꿔 넣으면 「남의 결재권을 내가 맡는」 줄이
 * 조용히 만들어진다.
 *
 * 🔴 `created_by_user_id` 에는 **actor** 가 들어간다. 본인이 스스로 맡겼는지 관리자가
 * 대신 세웠는지는 그 칸에만 남는다(`delegator_user_id` 와 같으면 본인).
 *
 * 🔴 **없는 사람과 지금 쓸 수 없는 계정을 가르지 않는다**(둘 다 `INVALID_USER`). 갈라
 * 주면 이 통로가 포털 사용자 목록을 묻는 조회 도구가 된다.
 */
export async function createApprovalDelegation(
  command: CreateDelegationCommand
): Promise<DelegationWriteResult> {
  // 모양 검사(같은 사람 · 기간)는 통로 쪽에서 이미 끝났다
  // (lib/approvals/delegation-request.ts). 🔴 그래도 **표의 CHECK 가 마지막 그물로
  // 남아 있다** — 이 함수를 다른 자리에서 직접 부르는 날 그것이 지킨다.
  let created: { id: string; delegatorName: string; delegateName: string; actorName: string };

  try {
    created = await db.transaction(async (tx) => {
      const { user: actor, authority } = await readActorWithAuthority(
        tx,
        command.actorUserId,
        command.clientId
      );

      // 🔴 「본인이면 언제나, 남의 것이면 관리자만」. 규칙은 순수 함수에 있다.
      const allowed = authorizeDelegationCreate({
        actorUserId: actor.id,
        delegatorUserId: command.delegatorUserId,
        actor: authority,
      });
      if (!allowed.ok) fail(allowed.code, allowed.message);

      // 🔵 두 사람을 한 질의로 읽는다. 둘이 같은 줄일 수 없는 것은 통로와 표의 CHECK 가
      //    이미 지킨다.
      const people = await tx
        .select(USER_FIELDS)
        .from(users)
        .where(inArray(users.id, [command.delegatorUserId, command.delegateUserId]));
      const delegatorRow = people.find((row) => row.id === command.delegatorUserId);
      const delegateRow = people.find((row) => row.id === command.delegateUserId);
      if (!isUsableUser(delegatorRow)) {
        fail("INVALID_USER", "결재권을 맡길 수 있는 계정이 아닙니다.");
      }
      if (!isUsableUser(delegateRow)) {
        fail("INVALID_USER", "대리 결재자로 지정할 수 있는 계정이 아닙니다.");
      }

      const [inserted] = await tx
        .insert(approvalDelegations)
        .values({
          delegatorUserId: command.delegatorUserId,
          delegateUserId: command.delegateUserId,
          startsAt: command.startsAt,
          endsAt: command.endsAt,
          reason: command.reason,
          createdByUserId: actor.id,
        })
        .returning({ id: approvalDelegations.id });

      return {
        id: inserted.id,
        delegatorName: delegatorRow.displayName,
        delegateName: delegateRow.displayName,
        actorName: actor.displayName,
      };
    });
  } catch (error) {
    if (error instanceof DelegationMutationError) return error.result;
    throw error;
  }

  // 🔴 커밋된 **뒤**에 적는다(머리말). 이 함수는 던지지 않는다.
  await appendAuditLog({
    actorUserId: command.actorUserId,
    actionType: "DELEGATION_CREATED",
    targetEntity: AUDIT_ENTITY,
    targetRecordId: created.id,
    clientId: command.clientId,
    previousValue: null,
    // 🔴 번호만이 아니라 **이름도** 적는다. 나중에 그 사람의 표시 이름이 바뀌어도 로그만
    // 읽고 누구였는지 알 수 있어야 한다 — 번호만 남기면 로그가 스스로를 설명하지 못한다.
    //
    // 🔴 `createdBy` 를 따로 적는다. 「본인이 맡겼나, 관리자가 세웠나」는 이 값과
    // `delegator` 를 맞대어야만 나오고, 그 구분이 이 기능에서 가장 나중에 문제가 될
    // 값이다(막지 않기로 한 「자기를 대리인으로」가 여기서 드러난다).
    newValue: {
      delegator: { id: command.delegatorUserId, name: created.delegatorName },
      delegate: { id: command.delegateUserId, name: created.delegateName },
      startsAt: command.startsAt.toISOString(),
      endsAt: command.endsAt.toISOString(),
      reason: command.reason,
      createdBy: { id: command.actorUserId, name: created.actorName },
      selfAssigned: command.actorUserId === command.delegatorUserId,
    },
  });

  return { ok: true, id: created.id };
}

/**
 * 위임 한 줄을 되돌린다 — 줄은 남고 되돌림 두 칸이 **함께** 채워진다.
 *
 * ── 🔴 인가가 **UPDATE 의 조건절에도** 들어간다 ─────────────────────────
 * 아래에서 읽어 판정한 뒤 같은 거래 안에서 다시 쓰는데, 조건절에 「아직 안 되돌림 ·
 * 아직 안 끝남」을 한 번 더 적는다. 행은 `FOR UPDATE` 로 잡아 두지만, 조건을 글로
 * 적어 두면 나중에 잠금을 손대는 사람이 무엇을 지켜야 하는지 코드에서 바로 본다.
 * 🔴 0행이면 성공으로 넘기지 않고 거절한다.
 *
 * 🔴 **「맡은 위임은 스스로 되돌릴 수 없다」가 여기서 막힌다.** 화면이 단추를 숨기는
 * 것에 기대지 않는다 — 규칙은 `checkDelegationRevocable` 에 있다.
 */
export async function revokeApprovalDelegation(
  command: RevokeDelegationCommand
): Promise<DelegationWriteResult> {
  let revoked: {
    id: string;
    now: Date;
    actorName: string;
    delegatorUserId: string;
    delegatorName: string | null;
    delegateUserId: string;
    delegateName: string | null;
    selfRevoked: boolean;
  };

  try {
    revoked = await db.transaction(async (tx) => {
      const now = new Date();

      const { user: actor, authority } = await readActorWithAuthority(
        tx,
        command.actorUserId,
        command.clientId
      );

      const [delegation] = await tx
        .select({
          id: approvalDelegations.id,
          delegatorUserId: approvalDelegations.delegatorUserId,
          delegateUserId: approvalDelegations.delegateUserId,
          endsAt: approvalDelegations.endsAt,
          revokedAt: approvalDelegations.revokedAt,
        })
        .from(approvalDelegations)
        .where(eq(approvalDelegations.id, command.delegationId))
        // 🔴 위임 줄만 잠근다 — 이름을 얻으려고 users 를 조인한 채로 FOR UPDATE 를
        //    걸면 사람 행까지 배타 잠금이 걸린다. 이름은 아래에서 따로 읽는다.
        .for("update");
      if (!delegation) fail("NOT_FOUND", "해당 위임을 찾을 수 없습니다.");

      const decision = checkDelegationRevocable({
        delegation,
        actorUserId: actor.id,
        actor: authority,
        now,
      });
      if (!decision.ok) fail(decision.code, decision.message);

      const updated = await tx
        .update(approvalDelegations)
        .set({
          // 🔴 **두 칸을 함께** 적는다. 한쪽만 적힌 줄은 표의
          // `approval_delegations_revocation_metadata` CHECK 가 아예 받아 주지 않는다 —
          // 판정 함수가 `revoked_at` 한 칸만 보기 때문에 DB 가 짝을 묶어 둔 것이다.
          revokedAt: now,
          revokedByUserId: actor.id,
        })
        .where(
          and(
            eq(approvalDelegations.id, command.delegationId),
            isNull(approvalDelegations.revokedAt),
            gt(approvalDelegations.endsAt, now)
          )
        )
        .returning({ id: approvalDelegations.id });
      if (updated.length === 0) {
        fail("CONFLICT", "이미 철회된 위임입니다. 최신 정보를 다시 불러와 주세요.");
      }

      // 이름은 잠그지 않고 읽는다(위 FOR UPDATE 주석). 사람 참조가 `restrict` 라 두
      // 줄은 언제나 실재한다.
      const names = await tx
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, [delegation.delegatorUserId, delegation.delegateUserId]));
      const nameOf = (id: string) => names.find((row) => row.id === id)?.displayName ?? null;

      return {
        id: updated[0].id,
        now,
        actorName: actor.displayName,
        delegatorUserId: delegation.delegatorUserId,
        delegatorName: nameOf(delegation.delegatorUserId),
        delegateUserId: delegation.delegateUserId,
        delegateName: nameOf(delegation.delegateUserId),
        selfRevoked: actor.id === delegation.delegatorUserId,
      };
    });
  } catch (error) {
    if (error instanceof DelegationMutationError) return error.result;
    throw error;
  }

  await appendAuditLog({
    actorUserId: command.actorUserId,
    actionType: "DELEGATION_REVOKED",
    targetEntity: AUDIT_ENTITY,
    targetRecordId: revoked.id,
    clientId: command.clientId,
    // 🔵 줄은 지워지지 않고 칸 둘이 채워질 뿐이다. 로그를 읽는 사람이 찾는 것은
    //    「살아 있던 위임이 이때 거둬졌다」이고, 그것을 보여 주는 것은 이 한 쌍이다.
    previousValue: { revokedAt: null, revokedBy: null },
    newValue: {
      delegator: { id: revoked.delegatorUserId, name: revoked.delegatorName },
      delegate: { id: revoked.delegateUserId, name: revoked.delegateName },
      revokedAt: revoked.now.toISOString(),
      revokedBy: { id: command.actorUserId, name: revoked.actorName },
      selfRevoked: revoked.selfRevoked,
    },
  });

  return { ok: true, id: revoked.id };
}
