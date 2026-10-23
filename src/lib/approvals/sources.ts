import type { ClientTile } from "@/lib/db/queries/clients";
import { APPROVAL_MAIL_KINDS } from "./kinds";

/**
 * ============================================================================
 * 결재를 물어볼 곳 — 어느 시스템의 어느 주소인가
 * ============================================================================
 * 알림 종의 `notifications/sources.ts` 와 **같은 규칙**으로 정한다. 그 파일에
 * 길게 적힌 근거를 여기서 다시 쓰지 않고, 같은 것과 다른 것만 적는다.
 *
 * ── 같은 것 ────────────────────────────────────────────────────────────────
 *  · **이 사람이 들어갈 수 있는 시스템**에만 묻는다(`listAccessibleClients`).
 *    들어갈 수 없는 시스템에 물으면 그 시스템에 「이 사람이 존재한다」를 알리는
 *    꼴이 된다.
 *  · 호스트와 포트는 **DB(`clients.launcher_url`)** 에서 오고, 코드에 적는 것은
 *    경로 하나뿐이다. 주소를 코드에 적으면 IP 가 바뀌는 날 고칠 곳이 시스템
 *    수만큼이 된다(docs/주소.md).
 *  · 주소를 알 수 없는 시스템은 **조용히 빠지지 않는다** — 까닭과 함께 돌려준다.
 *
 * ── 🔴 다른 것 하나: 시스템 목록을 여기 적지 않는다 ────────────────────────
 * 결재 통로를 가진 시스템은 **갈래 다섯이 말하고 있다**(approvals/kinds.ts).
 * 목록을 여기 또 적으면 같은 것이 두 벌이 되고, 한쪽은 조용히 낡는다 — 알림 쪽
 * 에서 실제로 두 번 낡았던 자리다(그 파일의 「여기에 그 이름들을 또 적지
 * 않는다」). 그래서 `APPROVAL_SOURCE_CLIENT_IDS` 는 상수가 아니라 **갈래 표에서
 * 뽑아낸 값**이다: 갈래가 늘면 물어볼 곳도 따라 는다.
 * ============================================================================
 */

/**
 * 세 시스템이 모두 같은 경로로 연 통로. 🔴 셋이 글자까지 같은 응답을 준다
 * (`{ items: [{ id, kind, kindLabel, subject, detail, requestedAt, href }], count }`).
 *
 * 🔵 알림 쪽처럼 시스템마다 경로를 따로 적을 수 있게 하지 않았다. 지금 셋이
 * 같고, 달라지는 날이 곧 「표(DB 칸)로 옮기는 날」이라는 판단도 그쪽과 같다.
 */
export const APPROVAL_SOURCE_PATH = "/api/integration/approvals";

/**
 * 결재 통로를 가진 시스템의 `client_id`.
 *
 * 🔴 손으로 적지 않는다 — 갈래 표에서 뽑는다(위 머리말). 차례는 갈래 표의 차례
 * 그대로라, 작업 기록에 찍히는 차례도 화면의 차례와 같아진다.
 */
export const APPROVAL_SOURCE_CLIENT_IDS: readonly string[] = [
  ...new Set(APPROVAL_MAIL_KINDS.map((entry) => entry.clientId)),
];

/** 물어볼 곳 하나. */
export type ApprovalSource = {
  /** `clients.client_id`. 🔴 토큰의 aud 가 되는 값이다. */
  clientId: string;
  /** 사람에게 보이는 이름. 작업 기록에 적는다. */
  name: string;
  approvalsUrl: string;
};

/** 통로는 있는데 물어볼 수 없는 시스템. 알림 쪽 `SkippedSource` 와 같은 모양. */
export type SkippedApprovalSource = {
  clientId: string;
  reason: "no_launcher_url" | "bad_launcher_url";
};

/**
 * 권한대로 걸러진 시스템 목록을 「물어볼 곳」으로 옮긴다.
 *
 * 입력 타입을 `ClientTile` 로 못 박아 둔 이유는 notifications/sources.ts 와 같다 —
 * 저쪽 조회가 바뀌면 여기서 컴파일이 깨지고, 이 함수는 `clients` 표를 보지
 * 않으므로 **받지 않은 시스템을 만들어 낼 방법 자체가 없다.**
 */
export function toApprovalSources(tiles: readonly ClientTile[]): {
  sources: ApprovalSource[];
  skipped: SkippedApprovalSource[];
} {
  const wanted = new Set(APPROVAL_SOURCE_CLIENT_IDS);
  const sources: ApprovalSource[] = [];
  const skipped: SkippedApprovalSource[] = [];

  for (const tile of tiles) {
    // 결재 통로가 없는 시스템. 빠지는 것이 정상이라 적지 않는다.
    if (!wanted.has(tile.clientId)) continue;

    if (!tile.launcherUrl) {
      skipped.push({ clientId: tile.clientId, reason: "no_launcher_url" });
      continue;
    }

    let origin: string;
    try {
      origin = new URL(tile.launcherUrl).origin;
    } catch {
      skipped.push({ clientId: tile.clientId, reason: "bad_launcher_url" });
      continue;
    }

    sources.push({
      clientId: tile.clientId,
      name: tile.name,
      approvalsUrl: `${origin}${APPROVAL_SOURCE_PATH}`,
    });
  }

  return { sources, skipped };
}
