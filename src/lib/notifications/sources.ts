import type { ClientTile } from "@/lib/db/queries/clients";

/**
 * ============================================================================
 * 어느 시스템에 물어볼 것인가
 * ============================================================================
 * 두 가지를 곱해서 정한다:
 *
 *  1. **이 사람이 들어갈 수 있는 시스템** — listAccessibleClients 가 이미 정한다.
 *     🔴 여기서 권한을 다시 판정하지 않는다. 앱 런처 타일·서비스 메뉴바와 **같은
 *     판정** 하나여야 한다(queries/clients.ts 의 그 주석, service-menu.ts 의
 *     같은 규칙). 판정이 두 벌이 되면 「타일에는 없는데 알림은 오는」 시스템이
 *     생기고, 그건 곧 접근 권한이 없는 시스템에 그 사람의 존재를 알리는 일이다.
 *
 *  2. **알림 통로를 가진 시스템** — 지금은 A/S · 휴가 관리 · 개선요청 셋이다.
 *     계측기·PO 에는 알림이 아예 없다.
 *
 * ── 🔴 2번을 왜 표(schema)가 아니라 여기 상수로 두는가 ──────────────────────
 * `backchannel_logout_uri` 가 이미 같은 일을 칸 하나로 하고 있고, 그쪽이 결국
 * 맞는 모양이다 — 주소는 DB 에 있어야 하고(docs/주소.md), 새 시스템이 붙을 때
 * 포털 코드를 고치지 않아야 한다.
 *
 * 그런데 칸을 하나 더 두는 것은 **마이그레이션**이고, 이 저장소의 규칙상
 * 스키마 변경은 먼저 보고하고 승인을 받아야 한다(CLAUDE.md DB 규칙). 이번
 * 조각은 통로를 여는 것이 목적이라 그 승인 대기에 묶이지 않도록 상수로 둔다.
 * **시스템이 둘째로 붙는 날이 칸을 만드는 날이다** — 그때까지는 고칠 곳이
 * 이 파일 하나뿐이고, 한 줄짜리 표를 DB 에 만드는 값보다 싸다.
 *
 * 🔴 **2026-09-22, 그 둘째 시스템이 붙었다**(휴가 관리, `dss-leave`). 그런데도
 * 칸으로 옮기지 않았다 — 사용자 결정이다. 까닭: 두 줄짜리 표를 위해 포털에
 * 마이그레이션을 하나 더 쌓는 값이 아직 고칠 곳 하나보다 비싸다. 위 문장은
 * 지운 것이 아니라 **미룬 것이다.** 셋째가 붙는 날, 또는 리버스 프록시로
 * 하위 경로 배치를 하는 날(아래 ⚠️) 다시 꺼낸다.
 *
 * 🔴 **2026-09-23, 그 셋째가 붙었다**(개선요청, `dss-improvements`). 이번에도
 * 칸으로 옮기지 않았다 — 역시 사용자 결정이다. 까닭: 이 조각에는 통로 둘과
 * 포털 첫 화면(타일의 빨간 점)이 이미 들어 있고, 칸을 만드는 것은 포털에
 * 마이그레이션을 하나 더 쌓는 **별개의 일**이다. 세 줄이 된 지금도 고칠 곳은
 * 여전히 이 파일 하나뿐이다. 그래서 또 미룬다 — **넷째가 붙는 날**, 또는
 * 리버스 프록시로 하위 경로 배치를 하는 날(아래 ⚠️) 꺼낸다.
 * (세 번째 미룸이다. 넷째에서도 같은 까닭으로 미루게 된다면, 그때는 위
 * 「칸을 만드는 날」 문장을 **상수로 두기로 정했다**고 고쳐 적는 편이 정직하다.)
 *
 * ── 주소는 여기 적지 않는다 ────────────────────────────────────────────────
 * 🔴 상수에 담는 것은 **경로**뿐이고, 호스트와 포트는 DB(`clients.launcher_url`)
 * 에서 온다. 그 값은 listAccessibleClients 가 `{lan}` 을 이 기계의 주소로 이미
 * 펼쳐 준 뒤다. 주소를 코드에 적으면 docs/주소.md 가 없애려던 바로 그 모양
 * ——「IP 가 바뀌면 고칠 곳이 시스템 수만큼」——으로 돌아간다.
 *
 * ⚠️ 남는 구멍을 정직하게 적어 둔다: 런처 주소의 **origin 만** 쓰므로, 리버스
 * 프록시가 어떤 시스템을 하위 경로(`https://dss.example.com/as/…`)로 서비스하면
 * 이 계산이 틀린 주소를 만든다. 지금은 시스템마다 포트가 따로라 해당이 없다.
 * 그 배치를 하는 날이 위의 「칸을 만드는 날」이다.
 * ============================================================================
 */

/** 한 시스템이 내주는 두 통로의 경로. A/S 가 실제로 열어 둔 주소다. */
export type NotificationSourcePaths = {
  /** 「이 사람의 지금 알림」(GET). */
  notifications: string;
  /** 알림 설정(GET · PUT). */
  settings: string;
};

/**
 * 알림 통로를 가진 시스템. 열쇠는 `clients.client_id` 다.
 *
 * 여기에 없는 시스템에는 **묻지 않는다.** 물어 봐야 404 가 돌아오고, 그 404 는
 * 「죽었다」와 구별되지 않아 종이 이유 없이 빨개진다.
 */
export const NOTIFICATION_SOURCE_PATHS: Readonly<Record<string, NotificationSourcePaths>> = {
  "rf-service-system": {
    notifications: "/api/integration/notifications",
    settings: "/api/integration/notification-settings",
  },
  /** 휴가 관리 — 「지금 내 차례인 휴가 결재」. 2026-09-22 붙었다. */
  "dss-leave": {
    notifications: "/api/integration/notifications",
    settings: "/api/integration/notification-settings",
  },
  /**
   * 개선요청 — 「아직 확인하지 않은 개선요청」. 2026-09-23 붙었다(셋째).
   *
   * 🔴 관리자에게만 보이는 알림이지만 **그 판정은 저쪽이 한다.** 포털은 역할을
   * 보지 않고(service.ts 의 그 주석), 관리자가 아닌 사람에게는 개선요청 쪽이
   * 빈 목록을 돌려준다.
   */
  "dss-improvements": {
    notifications: "/api/integration/notifications",
    settings: "/api/integration/notification-settings",
  },
};

/** 물어볼 곳 하나. */
export type NotificationSource = {
  /** `clients.client_id`. 🔴 토큰의 aud 가 되는 값이다. */
  clientId: string;
  /** 사람에게 보이는 이름. 종이 「어느 시스템의 알림인가」를 적을 때 쓴다. */
  name: string;
  notificationsUrl: string;
  settingsUrl: string;
};

/** 통로는 있는데 물어볼 수 없는 시스템. 조용히 빠지지 않도록 까닭과 함께 돌려준다. */
export type SkippedSource = {
  clientId: string;
  reason: "no_launcher_url" | "bad_launcher_url";
};

/**
 * 권한대로 걸러진 시스템 목록을 「물어볼 곳」으로 옮긴다.
 *
 * 입력 타입을 ClientTile 로 못 박아 둔 이유는 service-menu.ts 와 같다 — 저쪽
 * 조회가 바뀌면 여기서 컴파일이 깨진다. 그리고 이 함수는 clients 표를 보지
 * 않으므로 **받지 않은 시스템을 만들어 낼 방법 자체가 없다.**
 *
 * 차례는 받은 그대로다. listAccessibleClients 가 sort_order 로 줄을 세웠으니
 * 그것이 곧 종에 보일 차례가 된다.
 */
export function toNotificationSources(tiles: readonly ClientTile[]): {
  sources: NotificationSource[];
  skipped: SkippedSource[];
} {
  const sources: NotificationSource[] = [];
  const skipped: SkippedSource[] = [];

  for (const tile of tiles) {
    const paths = NOTIFICATION_SOURCE_PATHS[tile.clientId];
    if (!paths) continue; // 알림이 없는 시스템. 빠지는 것이 정상이라 적지 않는다.

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
      notificationsUrl: `${origin}${paths.notifications}`,
      settingsUrl: `${origin}${paths.settings}`,
    });
  }

  return { sources, skipped };
}
