import "server-only";
import { getIssuer } from "@/lib/config/env";
import { getSigningKey } from "@/lib/crypto/keys";
import { listClientsByClientIds } from "@/lib/db/queries/clients";
import { signPortalServiceToken } from "@/lib/oidc/service-token";
import {
  propagateDelegation,
  type DelegationPropagationResult,
  type DelegationPushCommand,
  type DelegationPushPlan,
  type SignDelegationToken,
} from "./delegation-push";
import { APPROVAL_SOURCE_CLIENT_IDS, planDelegationPush } from "./sources";

/**
 * ============================================================================
 * 결재권 위임 전파의 **배선** — 바깥 둘(DB · 서명 키)을 만지는 유일한 곳
 * ============================================================================
 * 판단과 차례는 delegation-push.ts 에 있고, 여기는 그 인자들에 진짜 구현을 끼운다.
 * approvals/service.ts 가 결재 메일에 대해 하는 일과 같은 자리다.
 *
 * ── 🔴 어디에 보낼지는 **갈래 표가 말한다** ─────────────────────────────
 * `APPROVAL_SOURCE_CLIENT_IDS` 를 쓴다 — 결재 메일·통합 승인함이 「어디에 물을까」를
 * 정할 때 쓰는 그 목록이고, 그것은 다시 `approvals/kinds.ts` 에서 뽑힌 값이다
 * (지금은 A/S · 재고관리 · 휴가 셋). 🔴 **여기에 시스템 이름을 또 적지 않는다** —
 * 결재 갈래가 늘면 전파할 곳도 따라 늘어야 하는데, 목록이 두 벌이면 한쪽이 조용히
 * 낡고 그 시스템에만 위임이 안 걸린다.
 *
 * ── 🔴 토큰의 `sub` 는 **지정한 사람**이다 ──────────────────────────────
 * 받는 쪽 셋은 이 값을 **쓰지 않는다**(누구에 대한 줄인지는 몸통에 있다). 그래도
 * 검증기가 `sub` 없는 토큰을 거절하므로 누군가는 실어야 하고, 실을 값으로 가장
 * 자연스러운 것이 **그 지정을 누른 사람**이다 — 저쪽 접근 로그에 「포털이 누구의 일로
 * 왔나」가 남는다. 🔴 **그 값으로 줄을 쓰면 안 된다**는 것은 받는 쪽의 규약이다
 * (그쪽 route.ts 머리말).
 *
 * ── 🔵 시스템 목록은 **한 요청에 한 번만** 읽는다 ───────────────────────
 * 한 번의 지정에서 전파는 최대 두 번 돈다(써 주기 + 되돌리기). 🔴 **되돌리기는 써 준
 * 곳과 같은 곳으로 가야 한다** — 그 사이에 `clients` 가 바뀌면 보낸 곳과 되돌리는 곳이
 * 달라져 줄이 남는다. 그래서 닫아 둔 목록 하나를 둘이 나눠 쓴다.
 * ============================================================================
 */

/** 이 사람의 이름으로 서명하는 함수. approvals/service.ts 의 `signerFor` 와 같은 모양. */
function signerFor(subject: string): SignDelegationToken {
  return async ({ audience, purpose }) => {
    const { key, kid } = await getSigningKey();
    return signPortalServiceToken({
      issuer: getIssuer(),
      audience,
      subject,
      purpose,
      key,
      kid,
    });
  };
}

/** 어디에 보낼지 한 번 읽어 둔다. 🔴 갈 수 없는 곳은 **조용히 빠지지 않는다.** */
async function loadPlan(): Promise<DelegationPushPlan> {
  const plan = planDelegationPush(await listClientsByClientIds(APPROVAL_SOURCE_CLIENT_IDS));
  for (const row of plan.unreachable) {
    // 🔴 전파가 실패로 끝날 것이고, 그러면 **아무도 위임을 못 맡긴다**(설계 B-13).
    //    고치는 명령까지 적어 둔다 — 증상만으로는 주소 문제인지 알 길이 없다.
    console.error(
      `[delegations] ${row.clientId} 에 위임을 전달할 수 없습니다(${row.reason}). ` +
        `npm run client:register 로 launcher_url 을 등록하고 클라이언트를 켜 두세요.`
    );
  }
  return plan;
}

/**
 * 한 번의 지정·철회가 쓸 전파 함수를 만든다.
 *
 * 🔴 **돌려주는 함수를 그 요청 안에서만 쓴다.** 닫아 둔 목록이 오래 살면 주소가 바뀐
 * 뒤에도 옛 주소로 보낸다 — 쓰기 하나에 하나씩 짓는 것이 전부다.
 *
 * @param actorUserId 지정을 누른 사람의 포털 `users.id`(토큰의 `sub` 가 된다).
 */
export function delegationPropagatorFor(
  actorUserId: string
): (command: DelegationPushCommand) => Promise<DelegationPropagationResult> {
  let plan: Promise<DelegationPushPlan> | null = null;
  const signToken = signerFor(actorUserId);

  return async (command) => {
    plan ??= loadPlan();
    return propagateDelegation({ plan: await plan, command, signToken });
  };
}
