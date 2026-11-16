import {
  PORTAL_SERVICE_TOKEN_PURPOSES,
  type PortalServiceTokenPurpose,
} from "@/lib/oidc/service-token";
import type { DelegationPushTarget, UnreachableDelegationSystem } from "./sources";

/**
 * ============================================================================
 * 결재권 위임을 **세 시스템에 써 준다** — 나가는 쪽의 판단 전부
 * ============================================================================
 * 2026-11-16 저녁에 방식이 뒤집혔다(설계 `dss-approvals/DELEGATION_DESIGN.md` 의
 * B-12). 그 전에는 각 시스템이 결재할 때마다 포털에 **물었고**(B-3), 이제는 포털이
 * 지정·철회할 때 **써 준다.** 이 파일은 그 「써 주기」의 전부다.
 *
 *     POST {시스템}/api/integration/delegations
 *     Authorization: Bearer <포털 서비스 토큰, 쓰임새 dss.delegations.write>
 *     { action, id, delegatorSub, delegateSub, startsAt, endsAt, reason }   ← upsert
 *     { action, id, revokedAt }                                            ← revoke
 *
 *     200 { outcome: "stored" }          적었다
 *     200 { outcome: "not_applicable" }  이 시스템에는 해당 없다 — 🔴 **성공이다**
 *     그 밖(4xx·5xx·망 오류·시간 초과)  → 🔴 **전파 실패**
 *
 * ── 🔴 전파 실패는 **지정 자체의 거절**이다 (설계 B-13) ───────────────────
 * 한 곳이라도 못 적으면 포털도 적지 않는다. 「맡겼는데 어딘가에선 안 듣는」 상태를
 * 만들지 않는 것이 그 결정의 전부다. 🔵 그 대가로 **한 시스템이 죽으면 아무도
 * 위임을 못 맡긴다** — 결재 자체는 멀쩡히 돈다(각 시스템이 제 표만 보므로).
 *
 * ── 🔴 왜 이 파일에는 DB 도 서명 키도 없는가 ────────────────────────────
 * 이 조각의 값어치는 **거절이 제대로 되는가** 하나에 달려 있다. 망도 서명도 인자로
 * 받으면 「셋 중 하나가 500 이면 저장하지 않는다」를 DB 없이 그대로 돌려 볼 수 있다
 * (delegation-push.test.ts). 진짜 구현을 끼우는 일은 delegation-push-service.ts 가
 * 한다 — approvals/gather.ts 와 approvals/service.ts 의 관계 그대로다.
 *
 * ── 🔴 규약에서 **글자까지 맞춰 둔 것 셋** (받는 쪽 셋이 이미 이렇게 검사한다) ──
 *  1. 쓰임새는 `dss.delegations.write`. 다르면 **셋 다 401** 이다.
 *  2. 시각은 **반드시 `Z` 또는 `±HH:MM` 이 붙은 ISO**. 없으면 400 이다 — 시간대 없는
 *     글자는 읽는 서버의 지역 시각이 되어 개발 PC(KST)와 NAS(UTC)에서 **아홉 시간
 *     다른 순간**이 되는데 오류가 한 번도 안 난다. 🔵 `toISOString()` 이 늘 지킨다.
 *  3. 🔴 **`upsert` 에 `revokedAt` 을 싣지 않는다.** 받는 쪽 셋은 「값이 오면 그대로
 *     적는」다 — 실수로 실으면 **갓 지정한 위임이 철회된 채로 저장된다.** 그래서
 *     이 파일의 upsert 타입에는 그 칸이 **아예 없다**(실을 방법 자체를 없앴다).
 * ============================================================================
 */

/**
 * 한 시스템을 기다리는 상한 2초.
 *
 * ── 🔴 짧게 잡는 쪽도 길게 잡는 쪽도 값을 치른다 ────────────────────────
 * 종(1.5초)·밤에 도는 메일(5초)과 또 다르다. 여기서 시간이 넘으면 「그 시스템만
 * 빠진다」가 아니라 **지정 자체가 거절된다**(B-13) — 느린 시스템 하나가 위임 기능을
 * 통째로 끄는 셈이라, 너무 짧게 잡으면 안 된다.
 *
 * 🔴 **그런데 위를 막는 것이 따로 있다: 승인함이 포털을 3초만 기다린다**
 * (dss-approvals 의 `PORTAL_APPROVALS_TIMEOUT_MS = 3000`, 그쪽
 * approvals/portal-delegations.ts 가 `create`·`revoke` 를 부르는 자리). 전파가 그
 * 3초를 넘기면 승인함은 **끊고 「실패」를 띄우는데 포털은 그대로 저장을 마친다** —
 * 사람은 실패로 알고 다시 누르고, 위임이 둘이 된다. 그래서 2초다: 세 곳을 **동시에**
 * 부르므로 최악이 2초이고, 포털의 사전 검사·저장·감사 기록에 1초가 남는다.
 *
 * 🔵 **되돌리기 전파는 그 3초 밖이다.** 실패한 요청에서만 돌고, 그때 승인함은 이미
 * 끊었거나 곧 거절을 받는다 — 사람이 보는 답은 어느 쪽이든 「실패」로 같다.
 */
export const DELEGATION_PUSH_TIMEOUT_MS = 2000;

/**
 * 지정(또는 덮어쓰기) 한 번.
 *
 * 🔴 **`revokedAt` 칸이 없다.** 받는 쪽 셋이 「값이 오면 그대로 적는」다고 적어 두었고
 * (그쪽 parse 주석), 실수로 싣는 순간 **갓 맡긴 위임이 철회된 채로** 세 시스템에
 * 저장된다 — 포털에는 살아 있는 줄이 남으므로 **아무도 못 알아챈다.** 타입에서 빼
 * 두면 실을 방법 자체가 없다.
 */
export type DelegationPushUpsert = {
  action: "upsert";
  /** 🔴 **포털이 정한 번호.** 받는 쪽은 이것을 기본키로 쓰고 재시도는 덮어쓰기가 된다. */
  id: string;
  /** 포털 `users.id`(= 각 시스템에 가는 `sub`). 제 열쇠로 바꾸는 일은 받는 쪽이 한다. */
  delegatorSub: string;
  delegateSub: string;
  startsAt: Date;
  /** 🔴 이 순간은 포함하지 않는다(반열린 구간) — 포털 표와 같은 규칙. */
  endsAt: Date;
  /** 안 적었으면 빈 글자. 널로 보내지 않는다. */
  reason: string;
};

/**
 * 철회 한 번. 🔴 **`id` 와 시각뿐이다** — 받는 쪽 셋이 나머지 칸을 **읽지 않는다**
 * (그쪽 주석: 사람을 다시 맞춰 보면 그 사이에 바뀐 번호 때문에 못 거두는 줄이 생긴다).
 */
export type DelegationPushRevoke = {
  action: "revoke";
  id: string;
  /** 🔴 **포털 표에 적을 시각과 같은 순간이어야 한다** — 어긋남 점검(B-14)이 둘을 맞댄다. */
  revokedAt: Date;
};

export type DelegationPushCommand = DelegationPushUpsert | DelegationPushRevoke;

/**
 * 망으로 나가는 몸통. 🔴 **여기 한 곳에서만 짓는다.**
 *
 * 🔵 값이 전부 글자다 — `Date` 를 그대로 실으면 JSON 직렬화가 알아서 바꿔 주지만,
 * 그러면 **나가는 모양이 코드에 안 적혀 있게** 된다(`delegation-request.ts` 의
 * `toWireDelegation` 과 같은 판단).
 */
export function toDelegationPushBody(command: DelegationPushCommand): Record<string, string> {
  if (command.action === "revoke") {
    return {
      action: "revoke",
      id: command.id,
      // 🔴 오프셋이 붙는다(`toISOString()` 은 늘 `Z` 로 끝난다). 안 붙으면 받는 쪽 400.
      revokedAt: command.revokedAt.toISOString(),
    };
  }
  return {
    action: "upsert",
    id: command.id,
    delegatorSub: command.delegatorSub,
    delegateSub: command.delegateSub,
    startsAt: command.startsAt.toISOString(),
    endsAt: command.endsAt.toISOString(),
    reason: command.reason,
    // 🔴 `revokedAt` 을 **적지 않는다**(위 타입 주석). 칸을 더하지 마라.
  };
}

/**
 * 받는 쪽의 답을 읽는다. 🔴 **둘 다 성공이고, 그 밖은 전부 실패다.**
 *
 * 🔴 **200 인데 모양이 다르면 실패로 본다.** 프록시가 끼어들어 빈 몸통을 주거나 저쪽이
 * 규약을 바꾸면 「적었는지 모르는」 상태인데, 모르는 것을 성공으로 읽으면 포털에만 줄이
 * 남는다 — 「안 바뀜」과 「모름」을 가르는 자리다.
 */
export function readDelegationPushOutcome(
  status: number,
  body: unknown
): "stored" | "not_applicable" | null {
  if (status !== 200) return null;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const outcome = (body as Record<string, unknown>).outcome;
  if (outcome === "stored" || outcome === "not_applicable") return outcome;
  return null;
}

/** 한 시스템의 결과. 🔴 `not_applicable` 은 **성공 쪽**이다. */
export type DelegationPushOutcome =
  | { clientId: string; name: string; ok: true; outcome: "stored" | "not_applicable" }
  | { clientId: string; name: string; ok: false; reason: string };

/** 전파 한 번의 결과. */
export type DelegationPropagationResult = {
  /** 🔴 **셋이 모두 성공했는가.** 하나라도 아니면 거짓이고, 그러면 포털도 저장하지 않는다. */
  ok: boolean;
  /** 🔵 차례는 갈래 표의 차례다(sources.ts 의 `planDelegationPush`). */
  outcomes: readonly DelegationPushOutcome[];
};

/** 실패한 것만 추린다. 🔵 `ok` 와 **같은 자료에서** 나오므로 둘이 어긋날 수 없다. */
export function failedDelegationPushes(
  result: DelegationPropagationResult
): (DelegationPushOutcome & { ok: false })[] {
  return result.outcomes.filter(
    (outcome): outcome is DelegationPushOutcome & { ok: false } => !outcome.ok
  );
}

/**
 * 사람에게 보여 줄 거절 문구.
 *
 * 🔴 **어디가 안 됐는지를 이름으로 적는다.** 「전파에 실패했습니다」만으로는 다시
 * 시도할지 사람을 부를지 고를 수 없다 — 그 판단에 필요한 것이 시스템 이름이다.
 * 🔵 까닭(`reason`)은 안 적는다. `http_503`·`AbortError` 는 사람에게 할 말이 아니고,
 * 서버 로그와 응답의 `failedSystems` 에 남는다.
 */
export function describeDelegationPushFailure(result: DelegationPropagationResult): string {
  const names = failedDelegationPushes(result).map((outcome) => outcome.name);
  if (names.length === 0) {
    // 부르는 쪽이 성공을 실패로 다루고 있다는 뜻이다. 사람에게는 보일 일이 없지만
    // 거짓말은 하지 않는다.
    return "결재권 위임을 전달하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
  }
  return `${names.join(" · ")}에 결재권 위임을 전달하지 못했습니다. 잠시 뒤 다시 시도해 주세요.`;
}

/** 감사 기록에 적을 한 줄 — 「어디에 어떻게 적혔나」. 🔵 `not_applicable` 도 그대로 남는다. */
export function summarizeDelegationPush(
  result: DelegationPropagationResult
): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const outcome of result.outcomes) {
    summary[outcome.clientId] = outcome.ok ? outcome.outcome : `failed:${outcome.reason}`;
  }
  return summary;
}

/** 주체(사람)는 부르는 쪽이 쥔다. approvals/gather.ts 의 `SignApprovalToken` 과 같은 모양. */
export type SignDelegationToken = (params: {
  audience: string;
  purpose: PortalServiceTokenPurpose;
}) => Promise<string>;

/** 어디에 보낼지. `sources.ts` 의 `planDelegationPush` 가 짓는다. */
export type DelegationPushPlan = {
  targets: readonly DelegationPushTarget[];
  /** 🔴 **갈 수 없는 곳도 실패로 센다.** 빠뜨리면 그 시스템에만 위임이 안 걸린다. */
  unreachable: readonly UnreachableDelegationSystem[];
};

export type DelegationPushDeps = {
  signToken: SignDelegationToken;
  /** 시험이 갈아 끼운다. 평소에는 전역 fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * 한 곳에 한 번 보낸다. 🔴 **던지지 않는다** — 던지면 나머지 둘의 결과를 잃는다.
 *
 * `redirect: "manual"` 과 `cache: "no-store"` 의 까닭은 gather.ts 에 적힌 그대로다.
 * 여기서는 하나가 더 무겁다 — 리다이렉트를 따라가면 **남의 결재권을 넘기는 몸통**이
 * 저쪽이 고른 주소로 따라간다.
 */
export async function pushDelegationTo(params: {
  url: string;
  token: string;
  body: Record<string, string>;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<{ ok: true; outcome: "stored" | "not_applicable" } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await params.fetchImpl(params.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(params.body),
      signal: controller.signal,
      redirect: "manual",
      cache: "no-store",
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // 몸통이 깨졌어도 상태 코드는 뜻이 있다. 아래에서 모양 검사에 걸려 실패가 된다.
      payload = null;
    }

    const outcome = readDelegationPushOutcome(response.status, payload);
    if (outcome === null) {
      return {
        ok: false,
        reason: response.status === 200 ? "bad_shape" : `http_${response.status}`,
      };
    }
    return { ok: true, outcome };
  } catch (error) {
    // 시간 초과는 `AbortError` 로 온다 — 까닭을 글자로 남겨야 「죽었다」와 「느리다」를
    // 나중에 가를 수 있다.
    return { ok: false, reason: error instanceof Error ? error.name : "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 세 시스템에 **동시에** 써 준다.
 *
 * 🔴 **동시에 보내는 것이 맞다.** 차례로 보내면 상한이 세 배가 되어 승인함의 3초를
 * 넘기고, 그래 봐야 먼저 보낸 곳의 줄은 이미 적혀 있다 — 어차피 되돌려야 한다.
 *
 * 🔴 **갈 수 없는 곳(`unreachable`)도 실패 줄로 세운다.** 조용히 빠지면 「주소를 모르는
 * 시스템에만 위임이 안 걸린」 채로 지정이 성공하고, 그 사실은 아무 데도 안 남는다.
 *
 * 🔴 **보낼 곳이 한 곳도 없으면 실패다.** 「셋 다 성공」을 **빈 표본으로 공짜로 통과**
 * 시키지 않는다 — 시스템 목록을 못 읽은 날 모든 지정이 조용히 성공해 버린다.
 */
export async function propagateDelegation(
  params: { plan: DelegationPushPlan; command: DelegationPushCommand } & DelegationPushDeps
): Promise<DelegationPropagationResult> {
  const { plan, command } = params;
  const timeoutMs = params.timeoutMs ?? DELEGATION_PUSH_TIMEOUT_MS;
  const fetchImpl = params.fetchImpl ?? fetch;
  const body = toDelegationPushBody(command);

  const unreachable: DelegationPushOutcome[] = plan.unreachable.map((row) => ({
    clientId: row.clientId,
    // 🔵 이름을 모른다(타일이 없거나 주소가 깨졌다). 사람에게는 `client_id` 라도
    //    보여 주는 편이 「어디가」를 아무 말 않는 것보다 낫다.
    name: row.clientId,
    ok: false,
    reason: row.reason,
  }));

  if (plan.targets.length === 0 && unreachable.length === 0) {
    return {
      ok: false,
      outcomes: [{ clientId: "-", name: "-", ok: false, reason: "no_systems" }],
    };
  }

  const sent = await Promise.all(
    plan.targets.map(async (target): Promise<DelegationPushOutcome> => {
      let token: string;
      try {
        token = await params.signToken({
          audience: target.clientId,
          // 🔴 **읽기 쓰임새를 돌려쓰지 않는다**(파일 머리말 1번).
          purpose: PORTAL_SERVICE_TOKEN_PURPOSES.delegationsWrite,
        });
      } catch (error) {
        console.error(`[delegations] 토큰 서명 실패 (${target.clientId}):`, error);
        return { clientId: target.clientId, name: target.name, ok: false, reason: "sign_failed" };
      }

      const result = await pushDelegationTo({
        url: target.delegationsUrl,
        token,
        body,
        timeoutMs,
        fetchImpl,
      });
      return result.ok
        ? { clientId: target.clientId, name: target.name, ok: true, outcome: result.outcome }
        : { clientId: target.clientId, name: target.name, ok: false, reason: result.reason };
    })
  );

  const outcomes = [...sent, ...unreachable];
  return { ok: outcomes.every((outcome) => outcome.ok), outcomes };
}

/* ------------------------------------------------------------------ */
/* 차례 — 🔴 전파가 먼저, 포털 저장이 나중                               */
/* ------------------------------------------------------------------ */

/** 되돌리기 전파를 했는가, 됐는가. 🔵 셋 다 **로그에만** 쓰인다. */
export type DelegationCompensation = "not_needed" | "reverted" | "revert_failed";

export type DelegationWriteFlow<T> =
  /** 전파도 저장도 끝났다. */
  | { status: "stored"; value: T; propagation: DelegationPropagationResult }
  /** 전파가 한 곳이라도 실패했다 — **포털에 적지 않았다.** */
  | {
      status: "propagation_failed";
      propagation: DelegationPropagationResult;
      compensation: DelegationCompensation;
    }
  /** 전파는 다 됐는데 포털 저장이 실패했다. 🔴 **되돌리기를 시도한 뒤** 돌려준다. */
  | {
      status: "store_failed";
      error: unknown;
      propagation: DelegationPropagationResult;
      compensation: DelegationCompensation;
    };

/**
 * 🔴 **이 조각의 차례를 정하는 자리.** 전파 → 포털 저장, 그리고 어긋나면 되돌리기.
 *
 * ── 🔴 왜 전파가 먼저인가 ───────────────────────────────────────────────
 * 뒤집으면 「포털에는 있는데 어느 시스템에선 안 듣는」 위임이 생기고, 그것이 설계
 * B-13 이 없애려는 바로 그 상태다. 전파를 먼저 하면 남는 틈은 반대쪽 하나뿐이고 —
 * **각 시스템에만 줄이 남는 것** — 그쪽은 아래에서 되돌린다.
 *
 * ── 🔴 되돌리기는 **보낸 곳 전부**에 간다 ───────────────────────────────
 * 「적었다고 답한 곳」에만 보내지 않는다. 시간이 넘거나 500 을 받은 곳은 **적혔는지
 * 모르는** 곳이고, 모르는 쪽을 그냥 두면 거절된 지정이 그 시스템에서만 살아 있게
 * 된다. 🔵 철회는 멱등이고 없는 줄에는 `not_applicable` 이라 괜히 보내도 해가 없다.
 *
 * ── 🔴 **철회 전파는 되돌리지 않는다** ──────────────────────────────────
 * 되돌리려면 지워진 줄을 다시 살려야 하는데, 규약에 「살리기」가 없다(upsert 로
 * 되살릴 수는 있지만 그 순간 **거둔 위임이 부활한다**). 설계 B-13 이 「거둔 줄
 * 알았는데 안 거둬진」 쪽을 더 위험하다고 못 박았으므로, 철회는 **덜 열린 쪽으로
 * 기운 채** 남긴다 — 각 시스템에서는 거둬지고 포털에는 살아 있다. 사람이 [되돌리기]를
 * 다시 누르면 **같은 번호**로 다시 전파되어 양쪽이 맞는다.
 *
 * ── 🔴 되돌리기도 실패할 수 있다 ────────────────────────────────────────
 * 그때는 **로그를 분명히 남긴다**(어긋남 점검, 설계 B-14 과 조각 9 가 찾을 단서).
 * 던지지는 않는다 — 사람에게 돌려줄 답은 어차피 「실패」 하나다.
 */
export type PropagateThenStoreParams<T> = {
  command: DelegationPushCommand;
  /** 🔴 **되돌리기도 이 함수로 보낸다** — 보낸 곳과 되돌릴 곳이 같아야 한다. */
  propagate: (command: DelegationPushCommand) => Promise<DelegationPropagationResult>;
  /** 포털에 적는 일. 🔵 던지는 것을 실패로 본다(mutation 의 거절도 던져서 온다). */
  store: () => Promise<T>;
  /** 되돌리기 전파에 실을 시각. 🔵 시험이 고정한다. */
  now?: () => Date;
};

export async function propagateThenStore<T>(
  params: PropagateThenStoreParams<T>
): Promise<DelegationWriteFlow<T>> {
  const propagation = await params.propagate(params.command);
  if (!propagation.ok) {
    return {
      status: "propagation_failed",
      propagation,
      compensation: await revertPush(params, propagation, "전파가 한 곳이라도 실패"),
    };
  }

  try {
    return { status: "stored", value: await params.store(), propagation };
  } catch (error) {
    return {
      status: "store_failed",
      error,
      propagation,
      compensation: await revertPush(params, propagation, "포털 저장 실패"),
    };
  }
}

/** 🔴 윗 함수 전용. 되돌리기 한 번과 **그 실패를 남기는 한 줄**. */
async function revertPush<T>(
  params: PropagateThenStoreParams<T>,
  propagation: DelegationPropagationResult,
  why: string
): Promise<DelegationCompensation> {
  // 철회를 되돌리지 않는다(윗 주석).
  if (params.command.action !== "upsert") return "not_needed";

  const reverted = await params.propagate({
    action: "revoke",
    id: params.command.id,
    revokedAt: params.now?.() ?? new Date(),
  });
  if (reverted.ok) {
    console.warn(
      `[delegations] ${why} — 전파를 되돌렸습니다. id=${params.command.id} ` +
        `(${JSON.stringify(summarizeDelegationPush(propagation))})`
    );
    return "reverted";
  }

  // 🔴 **여기가 어긋남이 남는 유일한 자리다.** 줄이 어느 시스템에 남았는지 모르므로
  //    보낸 곳을 전부 적는다 — 조각 9(어긋남 점검)가 이 번호로 찾아간다.
  console.error(
    `[delegations] 🔴 ${why} 뒤 되돌리기까지 실패했습니다 — 이 번호의 위임이 포털에 없는 채로 ` +
      `각 시스템에 남아 있을 수 있습니다. id=${params.command.id} ` +
      `보냄=${JSON.stringify(summarizeDelegationPush(propagation))} ` +
      `되돌림=${JSON.stringify(summarizeDelegationPush(reverted))}`
  );
  return "revert_failed";
}
