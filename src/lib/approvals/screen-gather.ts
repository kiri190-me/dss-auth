import {
  PORTAL_SERVICE_TOKEN_PURPOSES,
} from "@/lib/oidc/service-token";
import { askApprovalSource, type SignApprovalToken } from "./gather";
import { parseScreenApprovalInbox, type ScreenApprovalItem } from "./screen-inbox";
import type { ApprovalSource, SkippedApprovalSource } from "./sources";

/**
 * ============================================================================
 * 「이 사람이 결재할 건」을 세 시스템에 **동시에** 묻는다 — 화면 몫
 * ============================================================================
 * 묻는 방식은 메일 쪽 gather.ts 와 같고(한꺼번에 · 짧게 끊고 · 실패를 삼키되
 * 조용히 넘기지 않는다), 왕복 자체는 저 파일의 `askApprovalSource` 를 **나눠
 * 쓴다.** 다른 것은 셋뿐이다:
 *
 *  ① **상한이 1.5초다**(아래). 메일 쪽 5초가 아니다.
 *  ② **일곱 칸을 다 들여온다**(screen-inbox.ts). 메일 쪽은 둘만 들여온다.
 *  ③ **내주는 모양이 승인함과의 계약이다**(아래 ScreenApprovalInbox).
 *
 * ── 🔴 왜 1.5초인가 — 메일의 5초를 쓰면 답이 도착 직전에 버려진다 ────────
 * 승인함은 포털에 **3초**에 끊는다(그쪽 PORTAL_APPROVALS_TIMEOUT_MS). 포털이
 * 각 시스템에 5초를 주면, 느린 시스템 하나 때문에 **포털이 아직 기다리는 동안
 * 승인함이 먼저 끊는다** — 그러면 멀쩡히 답한 나머지 둘의 결재까지 통째로
 * 사라지고, 화면에는 「포털에 물어보지 못했습니다」만 남는다. 🔵 종과 같은
 * 1.5초면 셋을 **동시에** 묻는 시간이 1.5초를 넘지 않아 3초 안에 반드시 돌아온다.
 *
 * 🔵 메일 쪽 5초가 틀린 값이라는 뜻이 아니다. 저쪽은 밤에 돌고 아무도 기다리지
 * 않아 「길게 기다려서라도 받는」 편이 옳고, 여기는 사람이 화면 앞에서 기다린다.
 *
 * ── 🔴 답을 캐시하지 않는다 ───────────────────────────────────────────────
 * 종은 사람마다 30초를 들고 있지만(notifications/service.ts) 결재함은 아니다.
 * **방금 결재한 건이 목록에 남아 있으면 안 된다** — 사람이 다시 누르고, 그
 * 시스템에서 「이미 처리된 건」을 보게 된다. 그래서 여기에도 라우트에도 캐시가
 * 없고, 응답에는 `no-store` 가 붙는다.
 *
 * ── 🔴 토큰의 쓰임새는 아직 **알림 읽기** 그대로다 ───────────────────────
 * 세 시스템의 결재 통로가 `dss.notifications.read` 를 요구한다. 포털이 먼저
 * 바꾸면 **통로 셋이 통째로 401** 이 된다. 네 저장소를 함께 고치는 날
 * `dss.approvals.read` 로 옮긴다(메일 쪽 gather.ts 머리말과 같은 약속이다).
 * ============================================================================
 */

/**
 * 읽기 타임아웃 1.5초. 🔴 **종의 READ_TIMEOUT_MS 와 같은 값이고, 일부러 같다.**
 *
 * 🔴 메일 쪽 `APPROVAL_READ_TIMEOUT_MS`(5000)를 **여기서 쓰면 안 된다** — 까닭은
 * 머리말의 「왜 1.5초인가」. 값을 한 곳에서 나눠 쓰지 않는 것도 그래서다: 한쪽을
 * 고치면 다른 쪽이 따라 바뀌는 편이 더 나쁘다.
 */
export const SCREEN_APPROVAL_READ_TIMEOUT_MS = 1500;

/**
 * 통로는 있는데 **물어볼 수 없는** 시스템. 주소를 모르는 경우다
 * (`clients.launcher_url` 이 비었거나 깨졌다 — sources.ts 의 SkippedApprovalSource).
 *
 * 🔴 **조용히 빼지 않는다.** 메일 쪽은 로그 한 줄로 끝내도 되지만(아무도 화면을
 * 보고 있지 않다), 화면에서 조용히 빠지면 그 시스템의 결재가 「없다」로 읽힌다.
 * 아래에서 `failed` 로 올려 승인함이 까닭을 글자로 말하게 한다.
 *
 * 🔵 이름이 함께 오는 것이 중요하다 — 승인함은 `name` 이 빈 줄을 **버린다**
 * (그쪽 toSourceStatus). 이름 없이 올리면 그 안내가 화면에 뜨지 않는다.
 */
export type UnreachableApprovalSource = {
  clientId: string;
  name: string;
  reason: SkippedApprovalSource["reason"];
};

/**
 * 한 시스템에 물어본 결과. 🔴 **셋 가운데 둘은 고장이 아니다.**
 *
 * 메일 쪽 `ApprovalSourceOutcome` 에 `name` 한 칸이 더 붙은 모양이다. 이름이
 * 필요한 것은 화면뿐이라(「재고 관리를 읽지 못했습니다」) 저쪽 타입을 넓히지
 * 않았다 — 메일 본문은 포털이 가진 글자만 쓴다는 울타리가 거기도 걸려 있다.
 */
export type ScreenApprovalSourceStatus =
  | { clientId: string; name: string; status: "ok"; count: number }
  /** 물어봤고 답도 받았는데 저쪽 사정으로 답할 수 없다(휴가의 계정 미연결). */
  | { clientId: string; name: string; status: "unavailable"; reason: string }
  /** 못 물어봤다. 죽었거나, 느리거나, 토큰이 거절됐거나, 주소를 모른다. */
  | { clientId: string; name: string; status: "failed"; reason: string };

/** 🔴 **이 네 칸이 승인함과의 계약이다**(그쪽 normalizeApprovalInbox 의 주석). */
export type ScreenApprovalInbox = {
  items: ScreenApprovalItem[];
  /**
   * 🔴 **그려 보낸 줄 수다.** 저쪽이 센 숫자를 그대로 나르지 않는다.
   *
   * 세 시스템은 `count = items.length` 로 계약해 두었고(A/S portal-approvals.ts 의
   * `count` 주석 — 한 줄이 한 번의 [승인하기]라 줄 수가 곧 셈이다), 종처럼
   * 「같은 대상을 한 번만 센다」가 없다. 그래서 저쪽 숫자와 줄 수가 다르면 그것은
   * **셈 규칙이 다른 것이 아니라 줄이 깨진 것**이고, 그때 깨진 숫자를 나르면
   * 승인함의 배지와 목록이 서로 다른 말을 한다.
   */
  count: number;
  sources: ScreenApprovalSourceStatus[];
  /**
   * 🔴 한 곳이라도 **못 물어봤으면** 참이다. `unavailable` 은 세지 않는다 —
   * 그것은 물어본 결과이지 고장이 아니다(메일 쪽 GatheredApprovals 와 같은 규칙).
   */
  degraded: boolean;
};

type SourceResult = {
  status: ScreenApprovalSourceStatus;
  items: ScreenApprovalItem[];
};

/**
 * 한 사람 몫으로 세 곳에 묻고 합친다. 🔴 **던지지 않는다.**
 *
 * 한 시스템이 죽어도 나머지 줄은 그대로 올라간다 — 그 사람이 오늘 처리해야 할
 * 일이 그만큼은 남아 있기 때문이다. 못 물어본 곳은 `sources` 와 `degraded` 에
 * 남고, 승인함이 그 자리에 까닭을 적는다.
 */
export async function gatherScreenApprovals(params: {
  sources: readonly ApprovalSource[];
  /** 주소를 몰라 **묻지도 못한** 시스템. 🔴 `failed` 로 함께 올라간다. */
  unreachable?: readonly UnreachableApprovalSource[];
  signToken: SignApprovalToken;
  /** 시험이 갈아 끼운다. 평소에는 전역 fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ScreenApprovalInbox> {
  const timeoutMs = params.timeoutMs ?? SCREEN_APPROVAL_READ_TIMEOUT_MS;
  const fetchImpl = params.fetchImpl ?? fetch;

  const results = await Promise.all(
    params.sources.map(async (source): Promise<SourceResult> => {
      const failed = (reason: string): SourceResult => ({
        status: { clientId: source.clientId, name: source.name, status: "failed", reason },
        items: [],
      });

      let token: string;
      try {
        token = await params.signToken({
          audience: source.clientId,
          purpose: PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead,
        });
      } catch (error) {
        console.error(`[approvals] 토큰 서명 실패 (${source.clientId}):`, error);
        return failed("sign_failed");
      }

      const result = await askApprovalSource({
        url: source.approvalsUrl,
        token,
        timeoutMs,
        fetchImpl,
      });

      if (!result.ok) {
        console.error(
          `[approvals] ${source.clientId} 에 결재할 건을 묻지 못했습니다 (${result.reason}).`
        );
        return failed(result.reason);
      }
      if (result.status !== 200) {
        console.error(`[approvals] ${source.clientId} 가 ${result.status} 로 답했습니다.`);
        return failed(`http_${result.status}`);
      }

      const parsed = parseScreenApprovalInbox(result.body, source);
      if (parsed === null) {
        // 200 인데 모양이 다르다. 🔴 「없다」로 읽으면 그 시스템의 결재가 아무
        // 표시도 없이 사라진다.
        console.error(`[approvals] ${source.clientId} 의 답이 약속과 다른 모양입니다.`);
        return failed("bad_shape");
      }

      if (parsed.dropped > 0) {
        // 🔴 열쇠를 지을 수 없어 버린 줄. 응답에 담을 자리가 없어 로그로 남긴다
        //    (screen-inbox.ts 의 `dropped`). 이 줄이 없으면 그 결재는 흔적도 없다.
        console.error(
          `[approvals] ${source.clientId} 의 줄 ${parsed.dropped}개에 id 가 없어 뺐습니다.`
        );
      }

      if (parsed.unavailable !== undefined) {
        // 🔴 「결재할 게 없다」가 아니다. 줄이 함께 왔더라도 저쪽이 사정을 적어
        //    보냈으면 그 사정을 올린다 — 승인함이 그 글자로 할 말을 고른다
        //    (`employee_not_linked` → 「계정이 직원 명단과 연결되지 않았습니다」).
        return {
          status: {
            clientId: source.clientId,
            name: source.name,
            status: "unavailable",
            reason: parsed.unavailable,
          },
          items: [],
        };
      }

      return {
        status: {
          clientId: source.clientId,
          name: source.name,
          status: "ok",
          // 🔴 **올려 보내는 줄 수**다(위 count 주석). 저쪽이 센 숫자가 아니다.
          count: parsed.items.length,
        },
        items: parsed.items,
      };
    })
  );

  const sources: ScreenApprovalSourceStatus[] = [
    ...results.map((result) => result.status),
    // 🔵 묻지도 못한 곳은 **뒤에** 붙인다. 차례에 뜻이 있는 자리가 아니고
    //    (승인함이 줄은 다시 세운다), 물어본 결과를 먼저 보여 주는 편이 읽기 쉽다.
    ...(params.unreachable ?? []).map(
      (row): ScreenApprovalSourceStatus => ({
        clientId: row.clientId,
        name: row.name,
        status: "failed",
        reason: row.reason,
      })
    ),
  ];

  const items = results.flatMap((result) => result.items);

  return {
    items,
    count: items.length,
    sources,
    degraded: sources.some((source) => source.status === "failed"),
  };
}
