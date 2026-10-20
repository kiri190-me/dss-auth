import type { PortalNotificationFeed, PortalNotificationItem } from "./merge";
import { NOTIFICATION_SOURCE_PATHS } from "./sources";

/**
 * ============================================================================
 * 「이 알림은 그만 보겠다」 — 읽고, 검사하고, 목록에서 거른다
 * ============================================================================
 * 2026-10-19 까지 지움 기록은 **각 사이트의 브라우저 저장소**에 있었다. 그런데
 * 브라우저 저장소는 주소(포트)별로 갈려서, A/S(3000)에서 지운 줄이 재고관리
 * (3800)의 종에는 그대로 떴다 — **같은 사람이 시스템마다 다른 목록을 본다.**
 * 그것을 포털 한 곳으로 모으는 중이고(설계안 docs/알림-지움-설계-2026-10-19.md),
 * 이 파일은 그 **계산 부분 전부**다.
 *
 * ── 왜 라우트가 아니라 여기인가 ────────────────────────────────────────────
 * site-feed.ts 가 DB 조회 넷을 전부 인자로 받은 것과 같은 이유다. 그리고 설계안
 * 7절이 그 이유를 한 줄로 적어 두었다: `service.ts`·`site-service.ts` 는
 * `server-only` 라 **시험이 아예 붙지 않는다.** 거르는 일이 거기 묻히면
 * 「숫자가 0 아래로 내려가는가」·「모양이 틀린 열쇠 하나가 일괄을 통째로
 * 거절시키는가」 같은 것을 **한 번도 돌려 보지 못한 채** 배포하게 된다.
 *
 * 🔴 그래서 이 파일은 **DB 도 네트워크도 모른다.** 열쇠가 등록된 시스템 것인지
 * 판정할 때조차 `clients` 표를 보지 않는다(아래 readDismissalKeys 의 주석).
 * ============================================================================
 */

/**
 * 한 번의 요청에서 받을 열쇠 수의 상한. **2026-10-20 사용자 결정.**
 *
 * 까닭은 **실제 알림 수**다. merge.ts 의 `MAX_ITEMS_PER_SOURCE` 주석이 그 근거를
 * 이미 갖고 있다 — 「A/S 의 알림은 결재·재고 같은 밀린 일이라 실제로는 두 자릿수를
 * 넘지 않는다」. 두 자릿수를 지우는 일괄에 200이면 몇 배다.
 *
 * ── 🔴 치르는 값 — 알고 받아들였다 ────────────────────────────────────────
 * 종에 보일 수 있는 줄은 **이론상 최대 1000**이다(시스템당 200 × 알림을 내는
 * 시스템 다섯). 그러니 한 사람에게 200줄이 넘게 쌓인 상태에서 「보이는 알림 전부
 * 지우기」를 누르면 **거절되고 아무 일도 일어나지 않는다.** 그때 그 사람이 손쓸
 * 방법은 몇 개씩 나눠 지우는 것뿐이다.
 *
 * 🔵 **이 거절을 만났다면 버그가 아니라 여기 적힌 결정이다.** 1000(= 이론상
 * 최대)으로 잡자는 안이 있었고, 그 값을 듣고도 200으로 정했다. 두 자릿수가
 * 실측이고 1000은 「그럴 수도 있다」이기 때문이다.
 *
 * ── 다시 꺼낼 조건 ────────────────────────────────────────────────────────
 * **개수로 꺼내지 마라.** 알림을 내는 시스템이 여섯째로 늘어도 이 값은 그대로다 —
 * 늘어난 것은 이론상 최대이지 사람이 실제로 쌓아 두는 양이 아니다.
 * 🔴 「200을 넘겨 일괄 지우기가 거절됐다」는 신고가 **실제로 들어오는 날** 올린다.
 * 그날 고칠 곳은 이 한 줄이다.
 *
 * 🔴 `MAX_ITEMS_PER_SOURCE` 로 적지 않았다 — 값이 우연히 같을 뿐 **뜻이 다르다.**
 * 저쪽은 「시스템 하나에서 받을 줄 수」이고 이것은 「한 요청에서 받을 열쇠 수」다.
 * 식으로 이어 두면 저쪽을 300으로 올리는 사람이 이것까지 같이 올리게 되고,
 * 그게 의도였는지 아무도 모른다. 여기서는 날숫자가 맞는 모양이다.
 */
export const MAX_DISMISSAL_KEYS_PER_REQUEST = 200;

/** 열쇠를 가른 결과. 🔴 `id` 는 **그 시스템 안에서만** 유일하다. */
export type DismissalKey = {
  /** `clients.client_id`. 어느 시스템이 낸 알림인가. */
  clientId: string;
  /** 그 시스템이 붙인 알림 id. `:` 가 더 들어 있을 수 있다. */
  id: string;
};

/**
 * `{client_id}:{id}` 를 가른다. 모양이 아니면 `null`.
 *
 * 🔴 **첫 `:` 에서만 가른다.** 열쇠를 만드는 쪽(merge.ts 의 parseSourceFeed)이
 * `` `${source.clientId}:${id}` `` 로 **앞에 붙이기만** 하기 때문이다 — 저쪽 id 에
 * 들어 있던 `:` 는 손대지 않는다. 그리고 A/S 의 id 에는 실제로 `:` 가 있다
 * (`REPAIR_CASE_APPROVAL:RC-2026-0001` 처럼 「종류:대상」 모양이다). 마지막
 * `:` 에서 가르거나 `split(":")` 로 조각을 세면 그 열쇠들이 전부 어긋나고,
 * **증상은 「지웠는데 그대로 뜬다」 하나뿐이라 어디가 틀렸는지 가리키지 않는다.**
 *
 * 앞뒤 어느 쪽이든 비어 있으면 열쇠가 아니다 — `:abc` 는 어느 시스템인지 없고
 * `abc:` 는 어느 알림인지 없다.
 */
export function parseDismissalKey(key: string): DismissalKey | null {
  const separator = key.indexOf(":");
  if (separator <= 0) return null; // `:` 가 없거나 맨 앞이다.

  const clientId = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!id) return null;

  return { clientId, id };
}

/**
 * 본문에서 읽어 낸 결과.
 *
 * 🔴 **거절 문구도 HTTP 상태도 여기 없다.** 그것은 라우트의 일이고(다음 조각),
 * 이 함수는 값만 돌려준다 — site-feed.ts 가 판정을 라우트 밖에 둔 것과 같은
 * 모양이라야 시험이 붙는다.
 */
export type DismissalKeysResult =
  | {
      ok: true;
      /** 쓸 수 있는 열쇠. 공백을 털고 중복을 없앤 뒤의 것이다. 하나 이상이다. */
      keys: string[];
      /**
       * 조용히 버린 열쇠 수 — 모양이 틀렸거나 모르는 시스템의 것.
       *
       * 🔵 **빈 조각과 중복은 세지 않는다.** 그 둘은 보낸 쪽의 잘못이 아니다 —
       * 일괄 지우기에서 같은 열쇠가 두 번 실리는 일은 정상이고, 뜻은 이미
       * 지켜졌다. 여기 세는 것은 **뜻을 못 지킨 열쇠**뿐이라야 뒷날 이 숫자를
       * 로그에서 보는 사람이 「저쪽 배포가 어긋났나」를 물을 수 있다.
       */
      dropped: number;
    }
  | { ok: false; reason: "no_keys" | "too_many" };

/**
 * `application/x-www-form-urlencoded` 본문에서 지울 열쇠를 읽는다.
 *
 * 🔴 **던지지 않는다.** 무엇이 와도 값이 나온다.
 *
 * ── 🔴 한 줄이 틀렸다고 전체를 거절하지 않는다 ──────────────────────────────
 * 모양이 틀렸거나 모르는 시스템의 열쇠는 **조용히 버리고 나머지는 처리한다.**
 * 일괄 지우기가 통째로 실패하면 사람이 할 수 있는 일이 없다 — 어느 줄이
 * 문제인지 화면에 나오지도 않고, 하나씩 지워 볼 수도 없다. 설계안 3-5 의 문 8 이
 * 적은 그대로다. 버린 수는 `dropped` 로 돌려줘 라우트가 로그에 남길 수 있게 한다.
 *
 * ── 🔴 왜 `clients` 표가 아니라 NOTIFICATION_SOURCE_PATHS 인가 ──────────────
 * 열쇠가 **실제로 나올 수 있는 집합**은 알림을 내는 시스템뿐이고, 그것이 바로 이
 * 상수다. 등록된 시스템 전체(`clients` 표에는 계측기·PO 도 있다)보다 **좁고
 * 정확하다** — 계측기는 제 알림이 없으므로 `dss-meters:…` 라는 열쇠는 어디서도
 * 만들어지지 않는다. 그리고 이 상수는 **DB 가 아니라 코드**라서 이 판정 전체에
 * 시험이 붙는다(설계안 7절이 요구한 모양이다). 🔵 알림을 내는 시스템이 늘면
 * sources.ts 에 어차피 한 줄이 들어가므로, 여기 고칠 것은 없다.
 */
export function readDismissalKeys(body: string): DismissalKeysResult {
  const params = new URLSearchParams(body);

  // 🔴 `get` 이 아니라 `getAll` 이다. 보내는 쪽이 `keys=a&keys=b` 로 나눠 실을 수
  // 있고(URLSearchParams.append 를 줄마다 부르면 그렇게 된다), `get` 은 그때
  // **첫 값만 읽고 나머지를 조용히 버린다.** 지운 줄 절반이 안 지워지는데 오류는
  // 어디에도 안 나는 모양이라, 받는 쪽에서 한 줄로 막아 둔다.
  const raw = params.getAll("keys").join(",");

  const seen = new Set<string>();
  const keys: string[] = [];
  let dropped = 0;

  for (const piece of raw.split(",")) {
    const key = piece.trim();
    if (!key) continue; // 꼬리 쉼표·빈 조각. 보낸 쪽의 잘못이 아니다.
    if (seen.has(key)) continue; // 같은 열쇠를 두 번 지우는 것은 한 번 지우는 것이다.

    const parsed = parseDismissalKey(key);
    // 🔴 `in` 이 아니라 `Object.hasOwn` 이다. `in` 은 프로토타입까지 보기 때문에
    // `constructor:x`·`toString:x` 같은 열쇠가 **등록된 시스템인 척 통과한다.**
    // 여기 들어오는 문자열은 바깥에서 지어 보낸 값이라 그 길을 막아 둔다.
    if (!parsed || !Object.hasOwn(NOTIFICATION_SOURCE_PATHS, parsed.clientId)) {
      dropped += 1;
      continue;
    }

    seen.add(key);
    keys.push(key);
  }

  // 🔴 **상한은 버리고 난 뒤 남은 수로 센다.** 쓰레기 열쇠가 섞였다는 이유로
  // 멀쩡한 일괄이 거절되면 안 되기 때문이다 — 버릴 것들은 어차피 표에 한 줄도
  // 쓰지 않으므로, 막으려는 「표가 폭주한다」와 아무 상관이 없다. 상한이 지키는
  // 것은 **실제로 쓰이는 행 수**이고, 그 수는 여기 `keys.length` 다.
  //
  // 🔵 본문 자체가 수 MB 로 오는 경우는 이 함수가 아니라 라우트가 막는다(다음
  // 조각). 여기서 막으면 「몇 글자까지 읽을 것인가」가 계산 규칙에 섞인다.
  if (keys.length > MAX_DISMISSAL_KEYS_PER_REQUEST) {
    // 🔴 **자르지 않고 거절한다.** 조용히 앞의 1000개만 받으면 사람은 전부
    // 지웠다고 믿는데 나머지는 그대로 남는다. 그 어긋남이 화면에 드러나는
    // 모양은 「지웠는데 다시 뜬다」 하나뿐이고, 그 말은 원인을 전혀 가리키지
    // 않는다 — 캐시를 의심하고 브라우저를 의심하다 끝난다. 거절은 적어도
    // 보낸 쪽에 그 자리에서 알려 준다.
    return { ok: false, reason: "too_many" };
  }

  // 쓸 열쇠가 하나도 없다. 🔵 `dropped` 가 0인지 아닌지(= 아무것도 안 보냈는지,
  // 보낸 것이 전부 쓰레기였는지)는 **여기서 나누지 않는다.** 어느 쪽이든 표에
  // 쓸 것이 없어 할 일이 같고, 나누면 라우트가 거절 문구를 두 벌 들어야 한다.
  if (keys.length === 0) return { ok: false, reason: "no_keys" };

  return { ok: true, keys, dropped };
}

/**
 * 지운 줄을 목록에서 빼고 숫자도 함께 줄인다.
 *
 * ── 🔴 받은 feed 를 제자리에서 고치지 않는다 ───────────────────────────────
 * 들어오는 feed 는 포털의 30초 캐시(cache.ts)에 **들어 있는 바로 그 객체**다.
 * 두 캐시 다 `get` 이 보관하던 객체를 **사본 없이 그대로 내준다.** 그래서
 * `items.splice` 나 `source.count--` 로 제자리에서 고치면 **거른 결과가 캐시에
 * 눌러앉는다.**
 *
 * 🔴 **남이 아니라 그 사람 자신이 깨진다.** 열쇠에 사람이 들어 있기 때문이다 —
 * `service.ts` 의 `feedCache` 는 `userId` 로, `site-service.ts` 의 `siteFeedCache`
 * 는 `siteFeedCacheKey(clientId, userId)` 로 잡는다. 남의 종으로 새지는 않는다.
 * 망가지는 것은 **같은 열쇠를 나눠 쓰는 다음 요청**이고, 그 열쇠를 나눠 쓰는 곳이
 * 실제로 둘이다: `feedCache` 는 종(`/api/notifications`)과 **앱 런처 타일의 빨간
 * 점**(`/apps`, shouldShowTileDot)이 함께 본다. 종이 거르면서 제자리에서 고치면
 * **거르지 않는 쪽인 타일의 숫자까지 같이 줄어든다.** 그리고 지움 기록은 되돌아
 * 온다 — 로그아웃 때 그 사람 행을 지우는 것이 설계안 3-6 이다. 기록은 사라졌는데
 * 캐시 속 사본은 30초 동안 그대로라, 그 사이에는 **아무도 지우지 않은 줄이 없는
 * 목록**이 나간다.
 *
 * 🔴 그래서 증상이 「**지우지도 않은 알림이 사라진다**」가 되는데, **재현이 안
 * 된다.** 30초가 지나면 캐시가 상해 다음 요청이 저쪽에 다시 물어보고, 사라졌던
 * 줄이 아무 일 없었다는 듯 돌아온다. 신고를 받고 열어 보면 멀쩡하다. 제자리
 * 수정을 막는 값어치가 거기 있다 — 고치기 어려워서가 아니라 **찾지 못해서** 비싸다.
 *
 * 🔵 merge.ts 의 `emptyFeed` 가 상수가 아니라 함수인 것도 같은 종류의 사고를
 * 막는다. 다만 크기가 다르다 — 그쪽은 **한 벌을 모든 사람이 나눠 쓰는** 값이라
 * 피해가 남에게까지 번지고, 여기는 그 사람의 칸 하나에 갇힌다. 막는 방법이 같을
 * 뿐이다.
 *
 * 그래서 여기서는 **언제나 새 객체·새 배열**을 만든다. 지울 것이 하나도 없을
 * 때도 그렇게 한다 — 「어떨 때는 원본을 그대로 돌려준다」는 성질이 있으면 부르는
 * 쪽이 둘 중 무엇을 받았는지 알 수 없고, 그 경우에만 깨지는 버그가 된다.
 * 🔵 줄 하나하나(`PortalNotificationItem`)는 아무도 고치지 않으므로 그대로 쓴다.
 *
 * ── 🔴 숫자를 다시 세지 않고 「뺀 만큼 뺀다」 ──────────────────────────────
 * `sources` 의 합으로 `count` 를 다시 세고 싶어지지만 그러지 않는다. 지금은 둘이
 * 같지만 그 불변식에 기대면 한쪽이 깨지는 날 **조용히 틀린 숫자**가 나온다.
 * 설계안 3-3 도 「지운 줄 수만큼 뺀다」로 적혀 있다.
 *
 * 🔵 **그래서 숫자가 정확하지 않을 수 있다 — 알고 받아들인 값이다.** 각 시스템은
 * 「같은 대상은 한 번만 센다」는 제 규칙으로 개수를 세는데(merge.ts 의 targetKey
 * 주석), 포털은 그 규칙을 모른다. 줄 둘이 한 대상이면 저쪽 개수는 1인데 여기서는
 * 2를 빼게 된다. 그때 숫자가 음수로 가지 않게 **0 에서 멈춘다.** A/S 가 이미 같은
 * 처리를 하고 있고, 설계안 3-3 이 그 어긋남을 적어 두었다.
 *
 * `degraded` 와 `sources` 의 **차례·`ok` 는 건드리지 않는다.** 「못 물어봤다」는
 * 지움과 아무 상관이 없는 사실이고, 그것이 흐려지면 빈 목록과 사고를 나눠 그릴
 * 수 없게 된다(merge.ts 의 degraded 주석).
 */
export function applyDismissals(
  feed: PortalNotificationFeed,
  dismissed: ReadonlySet<string>
): PortalNotificationFeed {
  const items: PortalNotificationItem[] = [];
  const removedBySource = new Map<string, number>();
  let removed = 0;

  for (const item of feed.items) {
    if (!dismissed.has(item.key)) {
      items.push(item);
      continue;
    }
    removed += 1;
    removedBySource.set(item.sourceId, (removedBySource.get(item.sourceId) ?? 0) + 1);
  }

  const sources = feed.sources.map((source) => ({
    ...source,
    count: Math.max(0, source.count - (removedBySource.get(source.clientId) ?? 0)),
  }));

  return {
    items,
    count: Math.max(0, feed.count - removed),
    sources,
    degraded: feed.degraded,
  };
}

/**
 * 사이트에 내줄 때의 모양 — 거른 feed 에 **그 사이트 몫의 지운 열쇠**가 한 칸 붙는다.
 *
 * 🔴 **왜 한 칸이 더 필요한가.** 포털은 부른 사이트 자신의 알림을 애초에 담아 주지
 * 않는다(site-service.ts 맨 위의 `exceptClientId`). 그래서 **그 사이트가 제 손으로
 * 그리는 제 알림**은 포털이 거를 수가 없다 — 포털의 손이 닿지 않는 목록이다. 이
 * 칸이 없으면 「A/S 에서 ✕ 를 눌렀는데 A/S 종에만 그대로 뜬다」가 된다.
 */
export type SiteDismissalFeed = PortalNotificationFeed & {
  /** 🔴 **부른 사이트 몫만.** 사이트가 제 알림 목록에서 이 열쇠들을 뺀다. */
  dismissed: string[];
};

/**
 * 거르고 나서, 사이트가 제 몫을 거를 수 있게 **그 사이트의 열쇠만** 얹어 준다.
 *
 * ── 🔴 왜 지운 열쇠를 전부 돌려주지 않는가 ─────────────────────────────────
 * 설계안 3-4 는 「포털이 `dismissed` 를 그대로 돌려주고 시스템이 제 접두사가 붙은
 * 것만 고른다」고 적었다. **그러지 않았다.**
 *
 * 🔴 **포털은 사이트마다 보여 줄 범위를 이미 좁혀서 내준다**(site-service.ts 맨 위의
 * `exceptClientId`, 그리고 그 앞의 listAccessibleClients — 그 사람이 들어갈 수 있는
 * 시스템의 알림만 담긴다). 그런데 지운 열쇠를 전부 보내면 그 좁힘이 무의미해진다.
 * **그 사람이 어느 시스템에서 무엇을 지웠는지**가 통째로 넘어가기 때문이다. 열쇠는
 * `{client_id}:{id}` 이고 그 `id` 에는 `REPAIR_CASE_APPROVAL:RC-2026-0001` 처럼
 * **수리 건 번호 같은 업무 식별자**가 들어 있다. 알림 본문은 걸러서 안 보내면서
 * 그 알림의 열쇠는 보내는 것은 앞뒤가 맞지 않는다.
 *
 * 사이트가 쓸 것은 제 것뿐이다. 포털이 골라 보내면 **새는 것도 없고 사이트가 할
 * 일도 준다**(접두사를 떼어 보며 고르는 코드가 사이트마다 한 벌씩 생기지 않는다).
 *
 * ── 🔴 판정은 parseDismissalKey 하나다 ────────────────────────────────────
 * `key.startsWith(clientId + ":")` 로 적으면 같은 규칙이 두 벌이 된다. 열쇠를
 * 가르는 규칙은 그 함수 하나여야 한다 — 「첫 `:` 에서만 가른다」가 거기 적혀 있고,
 * 모양이 깨진 열쇠(`:abc`·`abc:`)를 버리는 것도 거기 한 자리다. 표에서 읽어 온
 * 열쇠라 해도 **바깥에서 지어 보낸 문자열**이 쌓인 것이므로 믿지 않는다.
 *
 * 🔴 **받은 feed 를 제자리에서 고치지 않는다.** 위 applyDismissals 가 언제나 새
 * 객체를 만들고, 여기서는 그 결과에 칸 하나를 얹기만 한다 — 그 성질에 기대되
 * 깨뜨리지 않는다. 까닭은 저쪽 주석에 길게 적혀 있다(캐시에 든 바로 그 객체다).
 */
export function applySiteDismissals(
  feed: PortalNotificationFeed,
  dismissed: ReadonlySet<string>,
  clientId: string
): SiteDismissalFeed {
  const mine: string[] = [];
  for (const key of dismissed) {
    // 모양이 깨진 열쇠는 parseDismissalKey 가 null 을 낸다 — 터지지 않고 빠진다.
    if (parseDismissalKey(key)?.clientId === clientId) mine.push(key);
  }

  return { ...applyDismissals(feed, dismissed), dismissed: mine };
}
