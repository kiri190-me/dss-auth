/**
 * ============================================================================
 * `/apps` 승인함 타일의 **빨간 점** — 규칙 한 줄로 셋이 다 풀린다
 * ============================================================================
 * 사용자 요구(2026-10-23)는 셋이었다:
 *
 *   ① 확인하지 않은 **새 결재**가 생기면 통합 로그인에 빨간 점이 생긴다.
 *   ② **승인함에 들어가면** 점이 사라진다.
 *   ③ 확인하지 않았더라도 그 결재가 **해소됐다면** 점은 없어져도 된다.
 *
 * 포털에 「이 사람이 승인함을 마지막으로 연 때」(`approval_inbox_views.seen_at`)
 * 하나만 두면 셋이 전부 같은 한 줄에서 나온다:
 *
 *   점  =  결재 대기 건 중  `requestedAt > seen_at`  인 것이 하나라도 있는가
 *
 *   ② 승인함을 연다 → `seen_at` 이 지금으로 밀린다 → 남은 건이 전부 그보다
 *      앞서므로 점이 꺼진다.
 *   ③ 결재가 해소된다 → 그 시스템의 목록에서 **빠진다** → 셀 것이 없어 점이
 *      꺼진다. 🔴 **따로 처리할 것이 없다** — 포털은 결재를 저장하지 않고 매번
 *      세 시스템에 다시 묻기 때문이다(approvals/screen-service.ts).
 *
 * ── 🔴 이 파일은 **계산만** 한다 ──────────────────────────────────────────
 * DB 도 네트워크도 모른다. 바깥일은 전부 인자로 받는다 — 「못 읽었을 때」·
 * 「상한을 넘겼을 때」처럼 **실제로는 좀처럼 안 일어나는 갈래**가 이 점의 값어치를
 * 정하는데, 그것을 진짜 DB 와 세 시스템으로 돌려 볼 수는 없기 때문이다
 * (notifications/merge.ts · approvals/run.ts 와 같은 까닭).
 *
 * ── 🔴 「모르겠으면 점을 끈다」 ───────────────────────────────────────────
 * 아래 모든 갈래가 그 한 가지로 간다. 못 쟀는데 점을 켜면 사람이 눌러 들어가
 * 아무것도 없는 것을 보고, **그 다음부터는 진짜 점도 믿지 않는다**
 * (notifications/merge.ts 의 hasUnreadFor 가 `ok:false` 를 「없음」으로 두는 것과
 * 같은 판단이다).
 * ============================================================================
 */

/**
 * 통합 승인함의 `clients.client_id`.
 *
 * 🔴 **저장소 이름이 아니라 포털에 등록될 열쇠다**(저쪽 `src/lib/env.ts` 가 같은
 * 글자를 못 박아 두었다). 알림 종의 `dss-rf-trouble` 처럼 저장소 이름과 다른
 * 경우가 이미 있으므로, 「같아 보인다」로 넘기지 말고 등록된 값과 맞춘다.
 *
 * 🔵 승인함은 **결재를 내주는 쪽이 아니라 보여 주는 쪽**이라 물어볼 곳 목록
 * (sources.ts 의 `APPROVAL_SOURCE_CLIENT_IDS`)에는 들어 있지 않다. 그래서 그
 * 목록에서 뽑아 쓸 수가 없고 여기 한 줄로 적는다.
 */
export const APPROVALS_TILE_CLIENT_ID = "dss-approvals";

/**
 * 점을 재는 데 쓸 수 있는 **전체 시간**.
 *
 * 🔴 `/apps` 는 사람이 자주 여는 화면이고, 점 하나 때문에 느려지면 안 된다.
 * 안쪽에는 이미 상한이 있다 — 세 시스템에 묻는 왕복은 각각 1.5초에 끊긴다
 * (screen-gather.ts, 셋을 동시에 물으므로 합쳐서도 1.5초다). 여기서 한 겹 더
 * 두르는 까닭은 **DB 조회 둘에는 상한이 없기** 때문이다. 2.5초면 정상일 때는
 * 절대 닿지 않고(실측 왕복은 수백 ms), 무언가 멈춰 섰을 때만 걸린다.
 *
 * 🔴 상한에 걸리면 **점을 끈다.** 기다리게 하지 않는다 — 화면은 이미 타일을
 * 다 그려 두었고 점만 `<Suspense>` 로 흘려 넣는 중이다(apps/page.tsx).
 */
export const APPROVAL_TILE_DOT_BUDGET_MS = 2_500;

/** 승인함 타일인가. 🔴 **나머지 타일에는 이 점이 뜨지 않는다.** */
export function isApprovalsTile(clientId: string): boolean {
  return clientId === APPROVALS_TILE_CLIENT_ID;
}

/** 재는 데 필요한 칸 하나. 🔵 열 칸짜리 줄(ScreenApprovalItem)이 그대로 들어온다. */
export type ApprovalRequestedAt = {
  /** ISO 8601. 🔵 **빈 글자일 수 있다** — screen-inbox.ts 가 줄을 버리지 않는다. */
  requestedAt: string;
};

/**
 * **확인하지 않은 새 결재가 있는가.**
 *
 * @param seenAt 마지막으로 승인함을 연 때. `null` 이면 **한 번도 안 열었다.**
 *               🔴 「못 읽었다」를 여기에 `null` 로 넘기면 안 된다 — 그 둘은 다른
 *               답으로 가야 한다(queries/approval-inbox-views.ts).
 *
 * ── 갈래 ──────────────────────────────────────────────────────────────────
 *  · 결재가 **하나도 없다** → 점 없음. 요구 ③ 이 여기로 떨어진다 — 해소된 건은
 *    애초에 목록에 오지 않으므로 `seen_at` 을 건드리지 않아도 꺼진다.
 *  · `seen_at` 이 **없다**(한 번도 안 열었다) → 결재가 있으면 **점.** 🔴 이 사람
 *    에게는 모든 결재가 「아직 안 본 것」이다. 여기서 점을 안 띄우면 **승인함을
 *    한 번도 안 연 사람은 영영 점을 못 본다** — 가장 알려야 할 사람이다.
 *  · 그 밖 → `requestedAt` 이 `seen_at` 보다 **나중**인 줄이 하나라도 있으면 점.
 *
 * ── 🔴 읽을 수 없는 `requestedAt` 은 **세지 않는다**(「연 적이 있는」 사람에게) ──
 * 저쪽이 그 칸을 빼먹으면 빈 글자로 올라온다(screen-inbox.ts — 줄을 버리면 그
 * 결재가 아무 표시 없이 사라지므로 일부러 올린다). 그 줄은 **새것인지 알 수
 * 없다.** 모르는 것을 「새것」으로 치면 그 시스템이 그 칸을 빼먹는 동안 점이
 * **영영 안 꺼진다** — 승인함을 열어도 `seen_at` 과 견줄 값이 없기 때문이다.
 * 🔵 그 줄이 조용히 묻히지는 않는다: 승인함 화면이 「N건을 그리지 못했습니다」로
 * 말하고(그쪽 approvalTroubles), 포털은 로그에 남긴다(screen-gather.ts).
 *
 * 🔵 **같은 시각(동률)은 점이 아니다.** 승인함을 연 바로 그 순간의 건은 화면에
 * 함께 떠서 이미 본 것이다.
 */
export function hasNewApprovals(
  items: readonly ApprovalRequestedAt[],
  seenAt: Date | null
): boolean {
  if (items.length === 0) return false;
  if (seenAt === null) return true;

  const seen = seenAt.getTime();
  // Invalid Date. 🔴 기준이 없으니 「모르겠다」다 — 점을 켜지 않는다.
  if (!Number.isFinite(seen)) return false;

  return items.some((item) => {
    const requested = Date.parse(item.requestedAt);
    return Number.isFinite(requested) && requested > seen;
  });
}

export type ApprovalTileDotDeps = {
  /** 🔴 **던질 수 있다** — 못 읽으면 점을 끈다. `null` 은 「한 번도 안 열었다」. */
  readSeenAt: () => Promise<Date | null>;
  /** 세 시스템에 물어 모은 결재함. 🔴 **던질 수 있다.** */
  readApprovals: () => Promise<{ items: readonly ApprovalRequestedAt[] }>;
  /** 시험이 줄여 끼운다. 평소에는 위 상수. */
  budgetMs?: number;
};

/**
 * 재는 일 한 번. 🔴 **던지지 않는다. 늦지도 않는다.**
 *
 * 첫 화면을 그리는 길 위에 있으므로 이 함수가 던지면 `/apps` 가 통째로 500 이
 * 되고, 늦으면 점 하나 때문에 화면이 멎는다. 그래서 무엇이 잘못되든 **false**
 * 로 돌아온다 — 켜야 할 점을 못 켜는 것은 아쉬운 일이고, 못 켠 줄 모르는 채로
 * 화면이 안 뜨는 것은 사고다.
 *
 * ── 🔴 `seen_at` 을 **먼저** 읽는다 ──────────────────────────────────────
 * 못 읽으면 어차피 답을 낼 수 없으니, 그 자리에서 끝내고 **세 시스템에 묻지
 * 않는다.** DB 가 흔들리는 동안 사람들이 `/apps` 를 새로고침할 때마다 사내
 * 시스템 셋에 쓸모없는 요청이 꽂히는 것을 막는다.
 *
 * ── 🔴 여기서는 `seen_at` 을 **갱신하지 않는다** ──────────────────────────
 * 이 길은 타일을 그리느라 도는 길이지 사람이 승인함을 연 것이 아니다. 여기서
 * 갱신하면 **`/apps` 를 여는 것만으로 점이 꺼져** 점이 영영 안 뜬다. 갱신은
 * 승인함이 화면을 그리려고 부르는 통로 한 곳에서만 한다(screen-request.ts).
 */
export async function decideApprovalTileDot(deps: ApprovalTileDotDeps): Promise<boolean> {
  const measured = measure(deps).catch((error) => {
    // 🔴 조용히 넘어가지 않는다. 안 남기면 증상이 「점이 안 뜬다」 하나뿐이고,
    //    그것으로는 「결재가 없다」와 구별되지 않는다.
    console.error("[approvals] 승인함 타일의 점을 재지 못했습니다:", error);
    return false;
  });

  return withinBudget(measured, deps.budgetMs ?? APPROVAL_TILE_DOT_BUDGET_MS);
}

async function measure(deps: ApprovalTileDotDeps): Promise<boolean> {
  const seenAt = await deps.readSeenAt();
  const inbox = await deps.readApprovals();
  return hasNewApprovals(inbox.items, seenAt);
}

/**
 * 상한을 넘기면 **점을 끈 채로** 돌아간다.
 *
 * 🔵 늦게 도착한 답은 버린다 — 그때는 화면이 이미 나간 뒤다. `clearTimeout` 을
 * 빠뜨리면 답이 제때 와도 상한만큼 더 붙들고 있게 되므로(시험 실행도 그만큼
 * 늦게 끝난다) `finally` 에서 반드시 끈다.
 */
async function withinBudget(work: Promise<boolean>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      console.error(
        `[approvals] 승인함 타일의 점을 ${budgetMs}ms 안에 재지 못했습니다. 점을 띄우지 않습니다.`
      );
      resolve(false);
    }, budgetMs);
  });

  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
