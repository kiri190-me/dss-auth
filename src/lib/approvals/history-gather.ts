import { PORTAL_SERVICE_TOKEN_PURPOSES } from "@/lib/oidc/service-token";
import { askApprovalSource, type SignApprovalToken } from "./gather";
import {
  compareApprovalHistoryNewestFirst,
  parsePortalApprovalHistory,
  type PortalApprovalHistoryEntry,
} from "./history-entry";
import { approvalHistoryUrl, type ApprovalHistoryPeriod } from "./history-period";
import type { ApprovalHistorySource, SkippedApprovalSource } from "./sources";

/**
 * ============================================================================
 * 「이 사람이 이 기간에 한 결재」를 세 집에 **동시에** 묻는다
 * ============================================================================
 * 본보기는 바로 옆의 결재함 쪽(screen-gather.ts)이고, 판단을 새로 짓지 않고 그대로
 * 따른다 — 한꺼번에 보내고, 짧게 끊고, **실패를 삼키되 조용히 넘기지 않는다.**
 * 왕복 자체도 그 파일과 같은 함수를 나눠 쓴다(gather.ts 의 `askApprovalSource`
 * — GET · Bearer · 리다이렉트 안 따라감 · 캐시 안 함).
 *
 * ── 🔴 한 집이 죽어도 나머지를 준다. 다만 **「못 물었다」를 답이 말한다** ────
 * 셋 중 하나가 500·시간초과여도 나머지 둘의 내역은 그려야 한다 — 그 사람이 그
 * 기간에 한 결재가 그만큼은 실제로 있기 때문이다. 🔴 그런데 못 물어본 집을 **조용히
 * 빼면** 사람은 「그 기간에 결재한 게 없구나」로 읽는다. 그래서 결재함과 **같은 모양**
 * 으로 말한다: 집집마다 `sources[]` 한 줄이 서고, 한 곳이라도 못 물었으면
 * `degraded` 가 참이다.
 *
 * ── 🔴 결재함과 다른 것 하나: `unavailable` 이 **없다** ─────────────────────
 * 결재함 통로에는 「물어봤는데 저쪽 사정으로 답할 수 없다」가 따로 있었다(휴가의
 * `employee_not_linked`). 🔴 **내역 계약에는 그 칸이 아예 없다** — 세 집이 그렇게
 * 맞췄고(휴가 집 portal-approval-history.ts 의 그 문단), 까닭은 「이 기간에 결재한
 * 것이 없다」가 내역에서는 드문 일이 아니라 **기본값에 가깝기** 때문이다. 그 집에
 * 계정이 없는 사람도 **200 + 빈 `entries`** 를 받는다.
 * 🔴 그래서 여기 갈래는 둘뿐이다: `ok` 와 `failed`. 없는 셋째를 흉내 내지 마라.
 *
 * ── 🔴 집 이름을 붙이는 것은 **포털의 일**이다 ─────────────────────────────
 * 각 집은 제 이름을 모른다(제 응답에 제 이름을 담지 않는다). 승인함이 「어느
 * 시스템 결재인가」를 그리려면 포털이 `clients` 표의 이름을 붙여 줘야 한다 —
 * 줄마다(`sourceName`) 그리고 못 물어본 집에도(`sources[].name`). 🔵 이름 없이
 * 올리면 화면에 「무엇을 못 읽었는지」가 아예 안 뜬다.
 * ============================================================================
 */

/**
 * 읽기 상한 1.5초. 🔴 **결재함 쪽과 같은 값이고, 일부러 같다.**
 *
 * 까닭도 같다: 승인함은 포털에 3초에 끊는다. 포털이 집마다 더 길게 주면 느린 집
 * 하나 때문에 **포털이 아직 기다리는 동안 승인함이 먼저 끊고**, 멀쩡히 답한 나머지
 * 둘의 내역까지 통째로 사라진다. 셋을 **동시에** 묻으므로 1.5초면 3초 안에 반드시
 * 돌아온다.
 *
 * 🔴 **그래도 결재함의 상수를 나눠 쓰지 않는다.** 이쪽은 기간을 받아 훑는 조회라
 * 한 해를 묻는 날 느려질 수 있고, 그때 올려야 하는 것은 **이쪽 하나뿐**이다. 한
 * 곳에서 나눠 쓰면 올리는 순간 결재함이 따라 올라가 위의 3초 울타리를 넘는다.
 */
export const APPROVAL_HISTORY_READ_TIMEOUT_MS = 1500;

/**
 * 통로는 있는데 **물어볼 수 없는** 집. 주소를 모르는 경우다
 * (`clients.launcher_url` 이 비었거나 깨졌다).
 *
 * 🔴 **조용히 빼지 않는다.** 화면에서 조용히 빠지면 그 집의 결재 행적이 「없다」로
 * 읽힌다. 아래에서 `failed` 로 올려 승인함이 까닭을 글자로 말하게 한다.
 */
export type UnreachableHistorySource = {
  clientId: string;
  /** 🔴 **비면 안 된다.** 이름이 없으면 화면에 「무엇을」이 안 뜬다. */
  name: string;
  reason: SkippedApprovalSource["reason"];
};

/** 한 집에 물어본 결과. 🔴 갈래는 **둘뿐**이다(머리말). */
export type ApprovalHistorySourceStatus =
  | {
      clientId: string;
      name: string;
      status: "ok";
      /** 🔴 **올려 보낸 줄 수**다. 저쪽이 보낸 줄 수가 아니다. */
      count: number;
      /**
       * 정직하게 그릴 수 없어 포털이 **버린 줄 수**(history-entry.ts 의 `dropped`).
       *
       * 🔵 0 이 아니면 그 집의 배포가 계약과 어긋난 것이다. 승인함이 이 수로
       * 「N건을 그리지 못했습니다」를 띄울 수 있다 — 안 올리면 그 줄은 흔적도 없다.
       */
      dropped: number;
    }
  /** 못 물어봤다. 죽었거나, 느리거나, 토큰이 거절됐거나, 주소를 모른다. */
  | { clientId: string; name: string; status: "failed"; reason: string };

/** 🔴 **이 네 칸이 승인함과의 계약이다**(결재함 통로의 `ScreenApprovalInbox` 와 같은 모양). */
export type PortalApprovalHistory = {
  /**
   * 🔴 **세 집을 합쳐 새것부터 세운 목록**이다. 집별로 뭉쳐 있지 않다
   * (history-entry.ts 의 `compareApprovalHistoryNewestFirst`).
   */
  entries: PortalApprovalHistoryEntry[];
  /**
   * 🔴 **그려 보낸 줄 수다.** 저쪽이 센 숫자를 나르지 않는다 — 내역 계약에는 셈
   * 칸이 애초에 없고, 버린 줄이 있으면 `entries.length` 와 달라진다.
   */
  count: number;
  sources: ApprovalHistorySourceStatus[];
  /**
   * 🔴 한 곳이라도 **못 물어봤으면** 참이다. 결재함과 같은 규칙이다.
   *
   * 🔵 버린 줄(`dropped`)은 여기 안 센다 — 물어보기는 됐고, 그 수는 집집마다
   * `sources[]` 에 적혀 있다.
   */
  degraded: boolean;
};

type SourceResult = {
  status: ApprovalHistorySourceStatus;
  entries: PortalApprovalHistoryEntry[];
};

/**
 * 한 사람 몫으로 세 곳에 묻고 합친다. 🔴 **던지지 않는다.**
 *
 * 🔴 **한 집당 상한은 저쪽이 건다**(계약상 500줄). 포털이 합친 목록에 상한을 **다시
 * 걸지 않는 것은 일부러다** — 합친 뒤에 자르면 **한 집이 많이 보낸 탓에 다른 집의
 * 줄이 잘리고**, 잘렸다고 말할 칸이 계약에 없다. 집마다 이미 잘린 것은 그 집의
 * 약속이고, 포털이 그 위에 또 자르면 어느 쪽이 자른 것인지 아무도 모른다.
 */
export async function gatherApprovalHistory(params: {
  sources: readonly ApprovalHistorySource[];
  /** 주소를 몰라 **묻지도 못한** 집. 🔴 `failed` 로 함께 올라간다. */
  unreachable?: readonly UnreachableHistorySource[];
  period: ApprovalHistoryPeriod;
  signToken: SignApprovalToken;
  /** 시험이 갈아 끼운다. 평소에는 전역 fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<PortalApprovalHistory> {
  const timeoutMs = params.timeoutMs ?? APPROVAL_HISTORY_READ_TIMEOUT_MS;
  const fetchImpl = params.fetchImpl ?? fetch;

  const results = await Promise.all(
    params.sources.map(async (source): Promise<SourceResult> => {
      const failed = (reason: string): SourceResult => ({
        status: { clientId: source.clientId, name: source.name, status: "failed", reason },
        entries: [],
      });

      let token: string;
      try {
        token = await params.signToken({
          audience: source.clientId,
          // 🔴 쓰임새는 아직 **알림 읽기** 그대로다. 세 집의 내역 통로가 이 글자를
          //    요구하고(그 집들의 라우트 머리말), 포털이 먼저 바꾸면 **셋이 통째로
          //    401** 이 된다. `dss.approvals.read` 로 옮기는 날 네 곳을 함께 고친다.
          purpose: PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead,
        });
      } catch (error) {
        console.error(`[approval-history] 토큰 서명 실패 (${source.clientId}):`, error);
        return failed("sign_failed");
      }

      const result = await askApprovalSource({
        // 🔴 기간을 굽는 자리는 한 곳뿐이다(history-period.ts). 여기서 글자를 손으로
        //    이어 붙이면 `+09:00` 이 공백으로 풀려 세 집이 한꺼번에 400 을 낸다.
        url: approvalHistoryUrl(source.historyUrl, params.period),
        token,
        timeoutMs,
        fetchImpl,
      });

      if (!result.ok) {
        console.error(
          `[approval-history] ${source.clientId} 에 결재 내역을 묻지 못했습니다 (${result.reason}).`
        );
        return failed(result.reason);
      }
      if (result.status !== 200) {
        // 🔵 400 `invalid_period` 도, 404 `not_enabled`(통합 로그인을 안 쓰는 PC)도
        //    여기로 떨어진다. 둘 다 「못 물었다」가 맞는 말이다 — 그 집의 내역이
        //    없다는 뜻이 아니다. 까닭은 `http_400` 처럼 숫자로 올라가 화면에 뜬다.
        console.error(
          `[approval-history] ${source.clientId} 가 ${result.status} 로 답했습니다.`
        );
        return failed(`http_${result.status}`);
      }

      const parsed = parsePortalApprovalHistory(result.body, source);
      if (parsed === null) {
        // 200 인데 모양이 다르다. 🔴 「내역이 없다」로 읽으면 그 집의 결재 행적이
        // 아무 표시도 없이 사라진다.
        console.error(`[approval-history] ${source.clientId} 의 답이 약속과 다른 모양입니다.`);
        return failed("bad_shape");
      }

      if (parsed.dropped > 0) {
        // 화면에도 수가 뜨지만 로그에도 남긴다 — 고치는 사람은 화면이 아니라 로그를 본다.
        console.error(
          `[approval-history] ${source.clientId} 의 줄 ${parsed.dropped}개를 그릴 수 없어 뺐습니다(id 없음 또는 모르는 decision).`
        );
      }
      if (parsed.unknownRelations > 0) {
        // 🔴 그 집이 갈래를 늘렸는데 포털이 안 따라간 자리다. 줄은 그려지므로
        //    화면에는 안 뜨고(history-entry.ts 의 그 칸), 여기서만 보인다.
        console.error(
          `[approval-history] ${source.clientId} 의 줄 ${parsed.unknownRelations}개에 모르는 relation 이 와서 UNKNOWN 으로 접었습니다.`
        );
      }

      return {
        status: {
          clientId: source.clientId,
          name: source.name,
          status: "ok",
          count: parsed.entries.length,
          dropped: parsed.dropped,
        },
        entries: parsed.entries,
      };
    })
  );

  const sources: ApprovalHistorySourceStatus[] = [
    ...results.map((result) => result.status),
    // 🔵 묻지도 못한 곳은 **뒤에** 붙인다. 차례에 뜻이 있는 자리가 아니고(승인함이
    //    줄은 다시 세운다), 물어본 결과를 먼저 보여 주는 편이 읽기 쉽다.
    ...(params.unreachable ?? []).map(
      (row): ApprovalHistorySourceStatus => ({
        clientId: row.clientId,
        name: row.name,
        status: "failed",
        reason: row.reason,
      })
    ),
  ];

  // 🔴 **합친 뒤 다시 세운다**(머리말). 각 집은 제 안에서만 세워 보낸다.
  const entries = results
    .flatMap((result) => result.entries)
    .sort(compareApprovalHistoryNewestFirst);

  return {
    entries,
    count: entries.length,
    sources,
    degraded: sources.some((source) => source.status === "failed"),
  };
}
