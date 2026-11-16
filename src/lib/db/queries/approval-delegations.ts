import "server-only";
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import { approvalDelegations, users } from "@/lib/db/schema";
import {
  actingApproverSubjects,
  type ActingApproverSubjects,
  type ApprovalDelegationPeriod,
} from "@/lib/approvals/delegation";
import {
  DELEGATE_CANDIDATE_STATUS,
  type AllDelegationsResult,
  type ApprovalDelegationRow,
  type DelegateCandidate,
} from "@/lib/approvals/delegation-request";

/**
 * ============================================================================
 * 결재권 위임 읽기 — 판정이 보는 하나, 화면이 보는 둘, 고르개가 보는 하나
 * ============================================================================
 * 표는 `approval_delegations` 다(schema/approval-delegations.ts). 🔴 **판정은 여기서
 * 하지 않는다** — 줄을 읽어 순수 함수(lib/approvals/delegation.ts)에 넘길 뿐이다.
 * 「누를 수 있나」가 SQL 과 TS 두 벌로 적히면 「목록에는 뜨는데 눌리지 않는」(또는 그
 * 반대의) 짝이 생기고, 그 어긋남은 오류가 아니라 **사람이 포기할 때까지 조용하다.**
 *
 * 공개 함수 넷의 성격이 갈린다. 섞지 말 것:
 *
 *  · `resolveActingApproverSubjects` — **판정이 쓰는 값**이다. `sub` 목록 하나뿐이고
 *    이름이 없다. 각 시스템이 결재할 때마다 묻는다
 *  · `listApprovalDelegationsForUser` — **사람에게 보여 줄 값**이다. 이름·사유·만든
 *    사람까지 싣는다. 판정에 쓰지 마라
 *  · `listAllApprovalDelegations` — 같은 모양이지만 **남의 줄까지**다. 🔴 이것만 인가를
 *    **제 손으로** 본다. 까닭은 그 함수 머리말에 있다
 *  · `listDelegateCandidates` — 위임 표를 아예 읽지 않는다. **사람 명부**에서 「대리인
 *    으로 세울 수 있는 사람」을 이름까지만 뽑는다
 * ============================================================================
 */

const delegator = alias(users, "delegation_delegator");
const delegate = alias(users, "delegation_delegate");
const createdBy = alias(users, "delegation_created_by");
const revokedBy = alias(users, "delegation_revoked_by");

/**
 * 한 줄을 그리는 데 필요한 칸·조인을 **한 곳에서만** 적는다. 아래 두 조회가 같은 모양을
 * 돌려주어야 화면이 같은 부품으로 두 목록을 그리는데, 칸 목록을 두 벌 적어 두면 한쪽에만
 * 칸이 늘어나는 날이 오고 그때 `tsc` 는 아무 말도 하지 않는다(돌려주는 타입이 넓어질
 * 뿐이다).
 *
 * 🔴 사람 이름 칸은 포털에서 **`display_name`** 이다. A/S 의 같은 조회를 베껴 오면
 * `users.name` 을 찾다 멈춘다 — 그 저장소에만 있는 칸이다.
 *
 * `.where()` 와 `.orderBy()` 는 부르는 쪽이 붙인다.
 */
function delegationRowsBase() {
  return db
    .select({
      id: approvalDelegations.id,
      delegatorUserId: approvalDelegations.delegatorUserId,
      delegatorName: delegator.displayName,
      delegateUserId: approvalDelegations.delegateUserId,
      delegateName: delegate.displayName,
      startsAt: approvalDelegations.startsAt,
      endsAt: approvalDelegations.endsAt,
      reason: approvalDelegations.reason,
      createdByUserId: approvalDelegations.createdByUserId,
      createdByName: createdBy.displayName,
      createdAt: approvalDelegations.createdAt,
      revokedAt: approvalDelegations.revokedAt,
      revokedByUserId: approvalDelegations.revokedByUserId,
      revokedByName: revokedBy.displayName,
    })
    .from(approvalDelegations)
    // 사람 참조가 전부 `restrict` 이고 포털에는 사람 행을 지우는 코드가 아예 없으므로,
    // 참조된 users 행은 언제나 실재한다 — innerJoin 이어도 줄을 잃지 않는다.
    // 🔴 정지된(SUSPENDED) 사람의 줄도 빼지 않는다. 조용히 빼면 「분명히 맡겼는데
    // 목록에 없다」가 되고, 화면에서 까닭을 알 길이 없다.
    .innerJoin(delegator, eq(approvalDelegations.delegatorUserId, delegator.id))
    .innerJoin(delegate, eq(approvalDelegations.delegateUserId, delegate.id))
    .innerJoin(createdBy, eq(approvalDelegations.createdByUserId, createdBy.id))
    // 되돌린 사람만 널을 허락하는 칸이라 여기만 leftJoin 이다.
    .leftJoin(revokedBy, eq(approvalDelegations.revokedByUserId, revokedBy.id));
}

/**
 * 🔴 **「지금 이 사람의 자격으로 누를 수 있는 결재자」 전부** — 포털 `sub` 목록.
 * 맨 앞은 언제나 본인이고, 뒤에 지금 살아 있는 위임의 결재권자들이 붙는다.
 *
 * ── SQL 로 좁히는 셋은 전부 순수 함수가 **또** 거르는 조건이다 ───────────────
 * 대리인(`delegate_user_id`) · 안 되돌림(`revoked_at IS NULL`) · 안 끝남
 * (`ends_at > now`). 색인 칸 순서가 그대로 이 셋이다. 좁히기가 지우는 줄은 순수 함수가
 * 어차피 버리는 줄뿐이라 답이 달라지지 않는다 — **시작 시각은 일부러 SQL 에서 보지
 * 않는다.** 한 사람에게 걸린 위임은 많아야 몇 줄이고 색인에도 그 칸은 없다(표 쪽 주석).
 * 아직 시작 안 한 줄은 순수 함수가 버린다.
 *
 * 🔴 **맡긴 사람이 지금 쓸 수 있는 계정인지는 보지 않는다.** 위임을 만들 때 검사하고
 * (mutations/approval-delegations.ts), 그 뒤에 그 사람이 정지되어도 **대리인의 자격은
 * 그대로 둔다** — 자리를 비운 사이 그 결재를 넘겨 주는 것이 이 기능이 있는 까닭이다.
 * 여기에 「맡긴 사람이 활성인가」를 더하면, 사람이 자리를 비운 바로 그 상황에서 위임이
 * 함께 죽는다.
 *
 * 🔴 **던지는 것을 막지 않는다.** try/catch 로 감싸 본인 하나짜리 목록을 돌려주고
 * 싶어지지만 그러지 않는다 — 「DB 가 죽었다」와 「위임이 없다」는 다른 일인데 여기서
 * 뭉개면 부르는 쪽이 둘을 가를 수 없다. 못 물었을 때 「위임 없음」으로 볼지는 **저쪽의**
 * 결정이고(2026-11-16: 그렇게 보기로 했다), 그 판단을 포털이 대신해 주면 저쪽은 그런
 * 일이 있었다는 사실조차 모른다.
 */
export async function resolveActingApproverSubjects(
  userId: string,
  now: Date
): Promise<ActingApproverSubjects> {
  const rows: ApprovalDelegationPeriod[] = await db
    .select({
      delegatorUserId: approvalDelegations.delegatorUserId,
      delegateUserId: approvalDelegations.delegateUserId,
      startsAt: approvalDelegations.startsAt,
      endsAt: approvalDelegations.endsAt,
      revokedAt: approvalDelegations.revokedAt,
    })
    .from(approvalDelegations)
    .where(
      and(
        eq(approvalDelegations.delegateUserId, userId),
        isNull(approvalDelegations.revokedAt),
        gt(approvalDelegations.endsAt, now)
      )
    );

  return actingApproverSubjects(rows, userId, now);
}

/**
 * 「내가 맡긴 것」과 「내가 대신하고 있는 것」. 둘 다 **되돌린 줄·끝난 줄까지** 돌려준다
 * — 화면이 네 딱지(활성·예정·만료·철회됨)를 그리려면 죽은 줄도 보여야 하고, 상태는
 * 저장되지 않고 읽을 때 계산되기 때문이다.
 *
 * 🔵 한 줄이 양쪽에 동시에 들어가는 일은 없다 — 그러려면 맡긴 사람과 대신하는 사람이
 * 같아야 하는데, 표의 `…_different_users` CHECK 가 그런 줄을 못 만들게 한다.
 *
 * 🔵 질의를 한 번만 던진다(`OR`). 두 번 나눠 던지면 두 목록의 「지금」이 미세하게
 * 어긋나, 같은 화면에서 한쪽에만 보이는 줄이 생길 수 있다.
 *
 * 🔵 **여기에는 상한이 없다.** 한 사람에게 걸린 줄은 「그 사람이 자리를 비운 횟수」만큼만
 * 쌓이므로 본질적으로 작다. 상한이 필요한 쪽은 아래 「모두의 것」뿐이다.
 */
export async function listApprovalDelegationsForUser(userId: string): Promise<{
  given: ApprovalDelegationRow[];
  received: ApprovalDelegationRow[];
}> {
  const rows = await delegationRowsBase()
    .where(
      or(
        eq(approvalDelegations.delegatorUserId, userId),
        eq(approvalDelegations.delegateUserId, userId)
      )
    )
    .orderBy(desc(approvalDelegations.createdAt));

  return {
    given: rows.filter((row) => row.delegatorUserId === userId),
    received: rows.filter((row) => row.delegateUserId === userId),
  };
}

/**
 * 🔴 **끝난 줄을 몇 개까지 가져올까.** 살아 있는 줄에는 상한을 두지 않는다(그 집합은
 * 「지금 자리를 비운 사람 수」라 본질적으로 작고, 상한에 밀려 **되돌려야 할 줄**이 안
 * 보이는 것이 이 기능에서 가장 나쁜 일이다). 상한이 필요한 쪽은 끝난 줄뿐이다 — 줄을
 * 지우는 길이 없어 해가 갈수록 쌓이기만 한다.
 *
 * 🔵 50 에 깊은 뜻은 없다. 「한 화면에서 훑을 수 있는 양」이고, 더 뒤까지 찾아야 하면
 * 감사 로그가 영구 기록이다(위임을 만들 때도 되돌릴 때도 한 줄씩 남는다). 잘렸다는
 * 사실은 화면이 말해 준다(`finishedTruncated`).
 */
const FINISHED_DELEGATION_LIMIT = 50;

/**
 * **모든 사람의** 결재권 위임. 포털 관리자만 받을 수 있다.
 *
 * ── 🔴 인가를 **이 함수가** 본다. 통로·화면에 맡기지 않는다 ───────────────
 * 이 파일의 다른 조회들과 달리 여기만 제 손으로 깃발을 읽는다. 까닭은 돌려주는 것이
 * **남의 줄**이라서다 — 통로가 가리는 데 그치면 이 함수를 부르는 **새 자리**(다음에
 * 생길 화면·스크립트)가 생기는 날 조용히 다 새어 나간다. A/S 가 2026-10-26 에 같은
 * 자리에서 겪었다: 「화면에서 가린다」로 시작한 자리가 늘 그렇게 된다.
 *
 * 🔴 **열쇠는 `users.is_portal_admin` 하나다.** 포털에는 권한 표가 없고, 이 깃발의 뜻이
 * 바로 「포털 자체를 관리할 수 있는가」다(schema/users.ts). 쓰기(mutation)가 남의 위임을
 * 세우거나 거둘 때 보는 것과 **같은 값**이다 — 읽기를 쓰기보다 느슨하게 열지 않는다.
 * 되돌릴 수 없는 사람에게 남의 위임 목록을 보여 줄 까닭이 없다.
 *
 * 🔴 거절은 **빈 목록이 아니라 `ok: false`** 다(그 타입 쪽 주석).
 *
 * ── 왜 두 질의인가, 그리고 왜 겹치지 않는가 ────────────────────────────────
 * 상한이 필요한 쪽이 한쪽뿐이라 한 질의로는 표현되지 않는다. 두 질의의 조건은 **서로
 * 정확한 여집합**이고, 🔴 **「지금」을 바깥에서 한 번 받아 둘 다에 같은 값으로 넘긴다**
 * — 각자 `now()` 를 쓰면 두 질의 사이에 끝난 줄이 양쪽에서 빠지거나 양쪽에 들어간다.
 */
export async function listAllApprovalDelegations(
  actorUserId: string,
  now: Date
): Promise<AllDelegationsResult> {
  const [actor] = await db
    .select({ isPortalAdmin: users.isPortalAdmin })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  // 🔵 없는 사람도 여기서 막힌다 — 통로의 문 ⑤ 가 이미 걸렀지만, 이 함수를 다른
  //    자리에서 부를 날을 위해 **여기서도** 거절한다.
  if (!actor?.isPortalAdmin) return { ok: false, reason: "FORBIDDEN" };

  const isLive = and(
    isNull(approvalDelegations.revokedAt),
    gt(approvalDelegations.endsAt, now)
  );
  // 위의 정확한 여집합: 되돌렸거나(기간과 무관하다) 기간이 끝났거나.
  const isFinished = or(
    isNotNull(approvalDelegations.revokedAt),
    lte(approvalDelegations.endsAt, now)
  );

  const [live, finishedPage] = await Promise.all([
    delegationRowsBase().where(isLive).orderBy(desc(approvalDelegations.createdAt)),
    delegationRowsBase()
      .where(isFinished)
      .orderBy(desc(approvalDelegations.createdAt))
      // 🔵 한 건 더 받아 「더 있다」를 센다. 따로 COUNT 를 던지면 그 사이에 줄이 늘어
      // 「더 있다는데 다 보인다」가 될 수 있고, 질의가 하나 더 는다.
      .limit(FINISHED_DELEGATION_LIMIT + 1),
  ]);

  const finishedTruncated = finishedPage.length > FINISHED_DELEGATION_LIMIT;
  return {
    ok: true,
    view: {
      live,
      finished: finishedTruncated ? finishedPage.slice(0, FINISHED_DELEGATION_LIMIT) : finishedPage,
      finishedTruncated,
      finishedLimit: FINISHED_DELEGATION_LIMIT,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 대리인으로 세울 수 있는 사람 — 이름까지만                            */
/* ------------------------------------------------------------------ */

/**
 * 위임 고르개가 쓰는 **사람 목록**. 🔴 위임 표는 한 줄도 읽지 않는다.
 *
 * ── 🔴 인가를 보지 않는다. 이 목록은 **누구에게나 내려간다** ─────────────
 * 제 결재권을 맡기려면 「누구에게」를 골라야 하고, 고르개가 없으면 기능 자체가 없는
 * 것과 같다. 그래서 위의 `listAllApprovalDelegations` 와 달리 깃발을 묻지 않는다 —
 * 저쪽은 돌려주는 것이 **남의 줄**이지만 이쪽은 **사내 명부의 이름**이다.
 *
 * ── 🔴 그 대신 싣는 칸이 셋뿐이다 ───────────────────────────────────────
 * `is_portal_admin` 도 `status` 도 담지 않는다(`DelegateCandidate` 쪽 주석). 사람 칸을
 * 넉넉히 실은 다른 조회(`queries/users.ts` 의 `UserRow` 등)를 돌려쓰면 **사내 전원의
 * 상태와 권한**이 승인함의 화면에 그대로 실려 나간다.
 *
 * ── 🔴 이메일은 **여기서 거르지 않는다** ────────────────────────────────
 * 누구에게 내릴지는 **부르는 쪽**이 정한다(lib/approvals/delegation-request.ts 의
 * `candidatesForActor` — 포털 관리자에게만 싣는다). 이 함수는 **인자가 없어** 누가
 * 물었는지 알지도 못한다. 조회가 알아서 가리기 시작하면 「왜 어떤 때는 이메일이
 * 없나」를 설명할 자리가 사라진다.
 *
 * 🔴 **부른 사람 자신도 빼지 않는다**(뺄 기준이 하나가 아니다 — 통로 쪽 주석).
 *
 * 🔵 **상한이 없다.** 이 집합은 「사내 사람 수」라 본질적으로 작고, 잘라서 내보내면
 * 「분명히 있는 사람인데 고르개에 안 뜬다」가 된다. `users_status_idx` 가 이 조건
 * 그대로다.
 */
export async function listDelegateCandidates(): Promise<DelegateCandidate[]> {
  return db
    .select({ sub: users.id, name: users.displayName, email: users.email })
    .from(users)
    // 🔴 자격은 **쓰기 쪽과 같은 값**이어야 한다 — 넓히면 고를 수는 있는데 저장이
    //    거절되고, 좁히면 세울 수 있는 사람이 목록에 없다. 그래서 글자를 다시 적지 않고
    //    상수를 쓴다(delegation-request.ts 의 `DELEGATE_CANDIDATE_STATUS`).
    //    🔴 **다만 쓰기 쪽은 아직 그 상수를 끌어다 쓰지 않는다**(mutations 의
    //    `isUsableUser` 가 "ACTIVE" 를 직접 적는다). 이 값을 고치는 사람은 그 줄도
    //    함께 고쳐야 한다 — 어긋나도 `tsc` 는 아무 말을 하지 않는다.
    .where(eq(users.status, DELEGATE_CANDIDATE_STATUS))
    // 🔵 이름순. 고르개가 사람이 훑는 목록이라 들어온 차례(= 가입순)로는 못 찾는다.
    .orderBy(asc(users.displayName));
}
