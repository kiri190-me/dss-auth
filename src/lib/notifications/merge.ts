import type { NotificationSource } from "./sources";

/**
 * ============================================================================
 * 받은 것을 합친다 — 순수 계산만
 * ============================================================================
 * 각 시스템이 돌려준 JSON 은 **우리가 만든 값이 아니다.** 저쪽 배포가 어긋나면
 * 모양이 달라질 수 있고, 그때 포털이 터지면 종이 통째로 안 뜬다 — 설계서 F-8 이
 * 가장 나쁘다고 못 박은 바로 그 상태다. 그래서 받은 것을 믿지 않고 한 번 훑는다.
 *
 * 네트워크를 모르는 순수 함수로 둔다. 「모양이 깨진 답」·「거짓말하는 개수」
 * 같은 경우를 서버 없이 시험으로 돌려 볼 수 있어야 한다.
 * ============================================================================
 */

/**
 * 종에 그릴 알림 한 줄.
 *
 * 받은 줄(A/S 의 ExternalNotificationItem)에 **출처 두 칸과 key 하나**만 더한다.
 *
 * 🔴 `href` 는 **받은 그대로**다. A/S 가 이미 절대 주소로 만들어 보낸다
 * (그쪽 domain/notification-links.ts). 포털이 앞에 무엇이든 덧붙이면 주소가 두
 * 번 붙어 어디로도 가지 못한다.
 *
 * 🔴 A/S 의 `targetKey` 는 일부러 옮기지 않는다. 그 값은 「같은 대상은 한 번만
 * 센다」는 저쪽 규칙의 재료인데, 받는 쪽이 그것으로 개수를 다시 세면 A/S 의 종과
 * 포털의 종이 서로 다른 숫자를 보여 준다. 개수는 **저쪽이 센 값**을 쓴다.
 */
export type PortalNotificationItem = {
  /**
   * 목록 전체에서 유일한 열쇠. `client_id:id` 다.
   *
   * 각 시스템의 id 는 그 시스템 안에서만 유일하다 — 두 시스템이 같은 id 를 줄
   * 수 있고, 그대로 React key 로 쓰면 종이 줄을 잘못 지운다.
   */
  key: string;
  /** 어느 시스템에서 왔는가(client_id). */
  sourceId: string;
  /** 그 시스템의 사람이 읽는 이름. */
  sourceName: string;
  id: string;
  kind: string;
  /** 사람이 읽는 종류 이름. 🔴 포털은 각 시스템의 종류 코드표를 갖지 않는다. */
  kindLabel: string;
  subject: string;
  detail: string;
  /** 🔴 절대 주소. 손대지 않는다. */
  href: string;
};

/** 한 시스템에 물어본 결과. 종이 「어디가 빠졌는지」를 말할 수 있게 남긴다. */
export type PortalNotificationSourceStatus = {
  clientId: string;
  name: string;
  /** 물어봐서 답을 받았는가. false 면 그 시스템 줄은 비어 있다. */
  ok: boolean;
  /** 그 시스템의 배지 숫자. 못 물어봤으면 0. */
  count: number;
};

export type PortalNotificationFeed = {
  items: PortalNotificationItem[];
  /** 배지에 찍을 숫자. 각 시스템이 센 값의 합이다. */
  count: number;
  sources: PortalNotificationSourceStatus[];
  /**
   * 하나라도 못 물어봤는가.
   *
   * 🔴 **빈 목록과 다른 말이다.** 알림이 없는 것은 정상이고(A/S 실측: 활성
   * 사용자 12명 중 포털 계정과 이어진 사람이 4명), 못 물어본 것은 사고다.
   * 종이 그 둘을 같은 얼굴로 그리면 안 된다.
   */
  degraded: boolean;
};

/**
 * 이 시스템에 **아직 확인하지 않은 알림이 있는가.**
 *
 * 화면 안에 묻어 두면 갈래를 시험으로 돌려 볼 수 없어 여기 순수 함수로 둔다.
 *
 * 세 갈래가 모두 「없다」로 가지만 까닭이 다르다:
 *
 *  · **0건** — 밀린 일이 없다. 정상이다.
 *  · **`ok: false`** — 🔴 **못 물어봤다.** 위 degraded 주석이 적은 대로 「없다」와
 *    다른 말이지만, 타일에는 그 둘을 나눠 그릴 자리가 없다(점 하나뿐이다).
 *    그럴 때는 **없는 것처럼 두는 편**이 낫다 — 못 물어본 것을 빨간 점으로
 *    그리면 사람이 눌러 들어가 아무것도 없는 것을 보게 되고, 그 다음부터는
 *    진짜 점도 믿지 않는다.
 *  · **목록에 없다** — 알림 통로가 없는 시스템이다(계측기·PO). 물어본 적이
 *    없으니 알 수 있는 것도 없다.
 *
 * 🔴 이 함수는 **`clientId` 로만 맞춘다** — 어느 시스템인지 아는 코드가 한 줄도
 * 없다. 「점을 찍을 시스템인가」는 **다른 물음**이고, 아래 shouldShowTileDot 이
 * 따로 답한다. 둘을 한 함수에 섞으면 이 이름이 거짓이 된다.
 */
export function hasUnreadFor(
  sources: readonly PortalNotificationSourceStatus[],
  clientId: string
): boolean {
  const status = sources.find((source) => source.clientId === clientId);
  return status !== undefined && status.ok && status.count > 0;
}

/**
 * 🔴 앱 런처 타일(`/apps`)에 **점을 보여 줄 시스템. 2026-09-23 사용자 결정**:
 * 「빨간색 점은 개선요청에만 뜨면 돼.」
 *
 * 알림 통로를 가진 시스템은 셋이지만(A/S · 휴가 관리 · 개선요청) 점은 하나에만
 * 찍는다. 🔴 **알림 자체는 셋 다 흐른다** — 종을 열면 A/S 와 휴가 알림도 그대로
 * 보인다. 여기서 좁히는 것은 **포털 타일 위의 점**뿐이다. 그 둘은 다른 것이다.
 *
 * 🔴 **넓히려면 이 목록에 client_id 한 줄을 더하면 된다** — 다른 곳은 고칠 것이
 * 없다. 화면에도 hasUnreadFor 에도 시스템 이름이 없다.
 */
const TILE_DOT_CLIENT_IDS: ReadonlySet<string> = new Set(["dss-improvements"]);

/**
 * 이 타일에 **빨간 점을 찍을 것인가.**
 *
 * 두 물음의 곱이다 — 「점을 찍을 시스템인가」(위 목록) × 「밀린 일이 있는가」
 * (hasUnreadFor). 갈라 둔 까닭은 그 둘이 서로 다른 종류의 판단이기 때문이다:
 * 앞은 **사용자가 정한 화면 취향**이라 말 한마디로 바뀌고, 뒤는 **받은 자료를
 * 읽는 규칙**이라 바뀔 일이 거의 없다.
 *
 * ── 🔴 점이 사라지는 데 최대 30초가 걸린다 — 고장이 아니다 ────────────────
 * 개선요청의 알림이 0건이 되면(= 그 사람이 화면에 들어가 다 확인하면) 이 함수는
 * 곧바로 false 를 낸다. 그런데 **화면에서 점이 사라지기까지는 최대 30초가
 * 걸린다.** 이 함수가 늦는 것이 아니라, 먹이는 `sources` 가 옛 것이기 때문이다 —
 * 포털은 각 시스템에서 받아 온 답을 `FEED_TTL_MS`(service.ts, 30초) 동안 기억
 * 하고 그동안 다시 묻지 않는다. 🔴 **새로고침해도 30초 안에는 그대로다.**
 * 여기서 고칠 것이 없다.
 *
 * 🔴 **2026-09-23, 그 지연을 그대로 두기로 했다(사용자 결정: 「30초로 하자」).**
 * 까닭 둘: ① 통합 로그인 화면은 자주 보는 곳이 아니라 확인한 뒤 30초 안에 다시
 * 볼 일이 드물다. ② 없애려면 개선요청이 포털에 「기억해 둔 것을 버려라」를
 * 알리는 **새 통로**가 있어야 하는데, 그러면 **개선요청이 포털 주소를 알아야
 * 해서 묶임이 하나 는다**(지금은 포털만 저쪽 주소를 안다). 자세한 셈은
 * service.ts 의 FEED_TTL_MS 곁에 적어 두었다.
 */
export function shouldShowTileDot(
  sources: readonly PortalNotificationSourceStatus[],
  clientId: string
): boolean {
  if (!TILE_DOT_CLIENT_IDS.has(clientId)) return false;
  return hasUnreadFor(sources, clientId);
}

/** 한 시스템이 내준 목록(우리가 훑고 난 뒤). */
export type SourceFeed = {
  items: PortalNotificationItem[];
  count: number;
};

/**
 * 한 시스템에서 받을 줄 수의 상한.
 *
 * 종은 스크롤이 짧은 물건이고, 저쪽이 이상해져 수만 줄을 보내면 그 JSON 을
 * 붙드는 것만으로 포털이 느려진다. A/S 의 알림은 결재·재고 같은 밀린 일이라
 * 실제로는 두 자릿수를 넘지 않는다. 200이면 사람이 볼 수 있는 양의 몇 배다.
 */
export const MAX_ITEMS_PER_SOURCE = 200;

/** 받은 값이 문자열인가. 빈 문자열은 없는 것으로 본다(id·href 가 비면 쓸 수 없다). */
function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 링크가 **다른 사이트로 데려갈 수 있는 주소**인가.
 *
 * 🔴 여기서 주소를 고치지 않는다 — 걸러 낼 뿐이다. 앞에 우리 주소를 붙이는
 * 순간 A/S 가 이미 붙인 것과 겹쳐 두 번 붙는다.
 *
 * http·https 만 통과시키는 이유: 이 값은 곧 종의 `<a href>` 가 된다.
 * `javascript:` 가 섞여 들어오면 남의 시스템이 포털 화면에서 코드를 돌리는
 * 통로가 된다. 상대경로도 막는다 — 포털 안의 없는 주소로 가기 때문이다.
 */
function isNavigableHref(href: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * 한 시스템의 답을 훑는다. 🔴 **던지지 않는다** — 무엇이 와도 답이 나와야 한다.
 *
 * 줄 하나가 이상하면 그 줄만 버린다. 한 줄 때문에 그 시스템 전체를 버리면,
 * 멀쩡한 나머지 알림까지 사라진다.
 *
 * 개수는 저쪽이 센 값을 쓰되 **남은 줄 수를 넘지 못하게 깎는다.** 정상이라면
 * 저쪽 개수는 언제나 줄 수 이하다(같은 대상을 한 번만 세므로). 넘는다면 답이
 * 깨졌거나 우리가 줄을 버린 것이고, 어느 쪽이든 「보이는 것보다 큰 숫자」가
 * 배지에 찍히는 편이 더 나쁘다.
 */
export function parseSourceFeed(raw: unknown, source: NotificationSource): SourceFeed {
  if (typeof raw !== "object" || raw === null) return { items: [], count: 0 };

  const rawItems = (raw as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) return { items: [], count: 0 };

  const items: PortalNotificationItem[] = [];
  for (const entry of rawItems.slice(0, MAX_ITEMS_PER_SOURCE)) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const id = text(row.id);
    const href = text(row.href);
    const subject = text(row.subject);
    if (id === null || href === null || subject === null) continue;
    if (!isNavigableHref(href)) continue;

    items.push({
      key: `${source.clientId}:${id}`,
      sourceId: source.clientId,
      sourceName: source.name,
      id,
      // 종류는 있으면 좋은 것이다 — 없다고 알림 자체를 버리지 않는다.
      kind: text(row.kind) ?? "",
      kindLabel: text(row.kindLabel) ?? "",
      subject,
      detail: text(row.detail) ?? "",
      href,
    });
  }

  const rawCount = (raw as { count?: unknown }).count;
  const reported =
    typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0
      ? Math.floor(rawCount)
      : 0;

  return { items, count: Math.min(reported, items.length) };
}

/** 한 시스템에 물어본 뒤의 상태. 실패도 값으로 다룬다 — 던지지 않는다. */
export type SourceOutcome =
  | { source: NotificationSource; ok: true; feed: SourceFeed }
  | { source: NotificationSource; ok: false };

/**
 * 시스템별 결과를 하나로 합친다.
 *
 * **시간순으로 섞지 않는다.** A/S 가 내주는 알림에는 시각이 없다 — 밀린 일에서
 * 매번 파생되는 값이라 「생긴 때」라는 것이 아예 없다(그쪽 domain/notifications.ts).
 * 없는 값을 지어내 섞으면 순서가 거짓말이 된다. 그래서 **시스템 차례대로**
 * 이어 붙이고, 각 시스템 안의 차례는 그쪽이 준 그대로 둔다. 종은 시스템별로
 * 묶어 그리면 된다.
 */
export function mergeSourceOutcomes(outcomes: readonly SourceOutcome[]): PortalNotificationFeed {
  const items: PortalNotificationItem[] = [];
  const sources: PortalNotificationSourceStatus[] = [];
  let count = 0;
  let degraded = false;

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      degraded = true;
      sources.push({
        clientId: outcome.source.clientId,
        name: outcome.source.name,
        ok: false,
        count: 0,
      });
      continue;
    }
    items.push(...outcome.feed.items);
    count += outcome.feed.count;
    sources.push({
      clientId: outcome.source.clientId,
      name: outcome.source.name,
      ok: true,
      count: outcome.feed.count,
    });
  }

  return { items, count, sources, degraded };
}

/**
 * 물어볼 곳이 하나도 없을 때의 답. 🔴 오류가 아니다.
 *
 * 상수가 아니라 **함수**인 까닭: 이 값은 사람마다 갈리는 캐시에 들어간다.
 * 한 벌을 나눠 쓰면 누가 거기에 줄 하나를 밀어 넣는 순간 **모든 사람의 종에**
 * 그 줄이 뜬다. 매번 새로 만들면 그 길이 아예 없다.
 */
export function emptyFeed(): PortalNotificationFeed {
  return { items: [], count: 0, sources: [], degraded: false };
}
