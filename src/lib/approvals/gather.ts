import {
  PORTAL_SERVICE_TOKEN_PURPOSES,
  type PortalServiceTokenPurpose,
} from "@/lib/oidc/service-token";
import { parseApprovalInbox } from "./inbox";
import type { ApprovalSource } from "./sources";

/**
 * ============================================================================
 * 「이 사람이 결재할 건」을 세 시스템에 **동시에** 묻는다
 * ============================================================================
 * 방식은 통합 종의 `notifications/gather.ts` 를 그대로 따른다 — 한꺼번에 보내고,
 * 짧게 끊고, 실패를 삼키되 조용히 넘기지는 않는다. 그 파일의 머리말이 근거다.
 *
 * ── 🔴 왜 그 파일을 쓰지 않고 하나 더 두는가 ──────────────────────────────
 * 저쪽은 **운영에서 일곱 사이트의 종을 떠받치는 길**이다. 이 작업을 위해 저쪽에
 * 갈래를 하나 더 내면, 밤에 도는 메일 작업의 사정 때문에 낮에 도는 종이 흔들릴
 * 수 있다. 그리고 두 길은 실제로 다르다:
 *  · 답의 모양이 다르다(`items[].id·kind` 만 들여온다 — approvals/inbox.ts).
 *  · 🔴 **「물어볼 수 없다」와 「결재할 게 없다」를 갈라야 한다**(휴가 관리의
 *    `employee_not_linked`). 종에는 그런 갈래가 없다.
 *  · 타임아웃이 다르다(아래).
 *
 * ── 🔴 토큰의 쓰임새는 아직 **알림 읽기** 그대로다 ───────────────────────
 * 세 시스템의 결재 통로가 `dss.notifications.read` 를 요구한다. 「결재할 건」은
 * 종과 다른 것이라 쓰임새를 따로 두는 편이 최소 권한에 맞지만, 쓰임새 글자는
 * **포털과 세 시스템의 약속**이라 포털이 먼저 굽고 저쪽이 따라오는 순서로만
 * 바꿀 수 있다. 여기서 먼저 바꾸면 **통로 셋이 통째로 401** 이 된다. 양쪽을
 * 함께 고치는 날 `dss.approvals.read` 로 옮긴다(2026-10-23, 다음 조각).
 * ============================================================================
 */

/**
 * 읽기 타임아웃 5초. 🔴 **종의 1.5초보다 길다 — 일부러다.**
 *
 * 그 1.5초는 **사람이 종을 누르고 화면 앞에서 기다리는 시간**이었다. 이 길은
 * 밤에 작업 스케줄러가 돌리고 아무도 기다리지 않는다. 짧게 끊어서 잃는 것은
 * 「그 시스템의 결재 메일이 오늘 안 나간다」이고, 길게 잡아서 잃는 것은 작업이
 * 몇 초 더 도는 것뿐이다. 값이 크게 다르다.
 *
 * 🔵 그래도 상한은 둔다. 사람 수만큼 곱해지는 시간이라, 답 없는 시스템 하나가
 * 작업 전체를 밤새 붙들고 있으면 안 된다.
 */
export const APPROVAL_READ_TIMEOUT_MS = 5000;

/** 주체(사람)는 부르는 쪽이 쥐고 있다. notifications/gather.ts 와 같은 모양. */
export type SignApprovalToken = (params: {
  audience: string;
  purpose: PortalServiceTokenPurpose;
}) => Promise<string>;

export type ApprovalGatherDeps = {
  signToken: SignApprovalToken;
  /** 시험이 갈아 끼운다. 평소에는 전역 fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** 어느 시스템의 어느 결재건인가. 🔴 포털이 들고 다니는 전부다. */
export type GatheredApprovalItem = {
  clientId: string;
  id: string;
  kind: string;
};

/** 한 시스템에 물어본 결과. 🔴 셋 가운데 둘은 고장이 아니다. */
export type ApprovalSourceOutcome =
  | { clientId: string; status: "ok"; count: number }
  /** 물어봤고 답도 받았는데 저쪽 사정으로 답할 수 없다(휴가의 계정 미연결). */
  | { clientId: string; status: "unavailable"; reason: string }
  /** 못 물어봤다. 죽었거나, 느리거나, 토큰이 거절됐다. */
  | { clientId: string; status: "failed"; reason: string };

export type GatheredApprovals = {
  items: GatheredApprovalItem[];
  outcomes: ApprovalSourceOutcome[];
  /** 🔴 한 곳이라도 **못 물어봤으면** 참이다. `unavailable` 은 세지 않는다. */
  degraded: boolean;
};

export type ApprovalAskResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; reason: string };

/**
 * 한 곳에 한 번 묻는다. 🔴 **던지지 않는다.**
 *
 * `redirect: "manual"` 과 `cache: "no-store"` 의 까닭은 notifications/gather.ts
 * 에 적힌 그대로다 — 리다이렉트를 따라가면 `Authorization` 머리말의 토큰이
 * 저쪽이 고른 주소로 따라가고, 결재 목록은 사람마다 다르고 매번 새로 계산된다.
 *
 * ── 🔴 화면 쪽(screen-gather.ts)이 **이 함수를 나눠 쓴다** ────────────────
 * 결재를 묻는 길은 둘이다 — 밤에 도는 메일(이 파일)과 통합 승인함 화면
 * (screen-gather.ts). 둘은 **상한 · 들여오는 칸 · 내주는 모양**이 다르지만
 * **왕복 자체는 글자까지 같다**(GET · Bearer · 리다이렉트 안 따라감 · 캐시 안 함).
 *
 * 🔵 그래서 베끼지 않고 내보낸다. 베껴 두면 한쪽만 고치는 날 둘이 갈라지는데,
 * 갈라진 것이 `redirect: "manual"` 이면 **토큰이 저쪽이 고른 주소로 따라가고도
 * 아무 증상이 없다.** 🔴 이 파일의 머리말이 notifications/gather.ts 를 **안**
 * 쓰기로 한 것과 모순이 아니다 — 저쪽은 운영에서 일곱 사이트의 종을 떠받치는
 * 길이라 건드릴 수 없었고, 여기 둘은 같은 날 같은 뜻으로 난 결재 길이다.
 */
export async function askApprovalSource(params: {
  url: string;
  token: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<ApprovalAskResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await params.fetchImpl(params.url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${params.token}`,
        accept: "application/json",
      },
      signal: controller.signal,
      redirect: "manual",
      cache: "no-store",
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // 본문이 깨졌어도 상태 코드는 뜻이 있다(401·404 는 본문 없이도 읽힌다).
      body = null;
    }
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 한 사람 몫으로 세 곳에 묻고 합친다.
 *
 * 🔴 **던지지 않는다.** 한 시스템이 죽어도 나머지 시스템의 결재로 메일은 나가야
 * 한다 — 그 사람이 오늘 처리해야 할 일이 그만큼은 남아 있기 때문이다. 못 물어본
 * 시스템은 `degraded` 와 `outcomes` 에만 남는다.
 *
 * 🔵 못 물어본 시스템의 결재건은 **「보낸 기록」에도 남지 않는다.** 그러므로
 * 내일 그 시스템이 살아나면 그때 함께 나간다 — 하루 늦을 뿐 놓치지 않는다.
 */
export async function gatherApprovals(
  params: { sources: readonly ApprovalSource[] } & ApprovalGatherDeps
): Promise<GatheredApprovals> {
  if (params.sources.length === 0) {
    return { items: [], outcomes: [], degraded: false };
  }

  const timeoutMs = params.timeoutMs ?? APPROVAL_READ_TIMEOUT_MS;
  const fetchImpl = params.fetchImpl ?? fetch;

  const results = await Promise.all(
    params.sources.map(
      async (
        source
      ): Promise<{ outcome: ApprovalSourceOutcome; items: GatheredApprovalItem[] }> => {
        let token: string;
        try {
          token = await params.signToken({
            audience: source.clientId,
            purpose: PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead,
          });
        } catch (error) {
          console.error(`[approvals] 토큰 서명 실패 (${source.clientId}):`, error);
          return {
            outcome: { clientId: source.clientId, status: "failed", reason: "sign_failed" },
            items: [],
          };
        }

        const result = await askApprovalSource({
          url: source.approvalsUrl,
          token,
          timeoutMs,
          fetchImpl,
        });

        if (!result.ok) {
          return {
            outcome: { clientId: source.clientId, status: "failed", reason: result.reason },
            items: [],
          };
        }
        if (result.status !== 200) {
          return {
            outcome: {
              clientId: source.clientId,
              status: "failed",
              reason: `http_${result.status}`,
            },
            items: [],
          };
        }

        const parsed = parseApprovalInbox(result.body);
        if (parsed === null) {
          // 200 인데 모양이 다르다. 「없다」로 읽으면 그 시스템의 결재가 영영
          // 안 나가면서 아무 표시도 안 남는다.
          return {
            outcome: { clientId: source.clientId, status: "failed", reason: "bad_shape" },
            items: [],
          };
        }

        if (parsed.unavailable !== undefined) {
          // 🔴 「결재할 게 없다」가 아니다. 줄이 함께 왔더라도 저쪽이 사정을
          // 적어 보냈으면 그 사정을 올린다 — 지금 휴가 관리는 이때 빈 목록을
          // 보내지만, 그것은 저쪽 사정이지 이 함수가 기댈 약속이 아니다.
          return {
            outcome: {
              clientId: source.clientId,
              status: "unavailable",
              reason: parsed.unavailable,
            },
            items: [],
          };
        }

        return {
          outcome: { clientId: source.clientId, status: "ok", count: parsed.items.length },
          items: parsed.items.map((item) => ({
            clientId: source.clientId,
            id: item.id,
            kind: item.kind,
          })),
        };
      }
    )
  );

  return {
    items: results.flatMap((result) => result.items),
    outcomes: results.map((result) => result.outcome),
    degraded: results.some((result) => result.outcome.status === "failed"),
  };
}
