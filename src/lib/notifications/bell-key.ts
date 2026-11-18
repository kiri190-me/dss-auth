import { parseDismissalKey } from "./dismissals";
import { NOTIFICATION_SOURCE_PATHS } from "./sources";

/**
 * ============================================================================
 * 포털 제 화면의 종이 **되돌려 보낸 한 줄**에서 쓸 수 있는 열쇠만 꺼낸다
 * ============================================================================
 * 2026-11-18, 앱 목록 화면(`/apps`)에 종이 붙으면서 생긴 자리다. 그 종의 ✕ 와
 * 줄 누름은 **서버 액션**을 부르는데(lib/server/actions/notifications.ts),
 * 서버 액션의 인자는 **브라우저를 거쳐 온 값**이라 tsc 가 지켜 주는 범위
 * 밖이다 — 타입이 `NotificationBellItem` 이라고 적혀 있어도 그 모양으로 오지
 * 않는다. 그래서 받은 줄에서 쓸 값을 **꺼내는 자리**를 하나 두고, 거기서
 * 모양을 가린다.
 *
 * ── 🔴 왜 라우트의 readDismissalKeys 를 쓰지 않는가 ────────────────────────
 * 저쪽(dismissals.ts)은 `application/x-www-form-urlencoded` **본문 한 덩이**를
 * 읽는 함수다. 사이트 서버가 `keys=a,b,c` 로 보내오는 모양이고, 상한·중복
 * 제거·버린 수 세기가 한 묶음으로 들어 있다. 여기 오는 것은 **줄 하나짜리
 * 객체**라 본문도 묶음도 없다. 억지로 본문 문자열을 지어 넣으면 열쇠에 쉼표가
 * 들어 있는 날 한 줄이 둘로 갈린다.
 *
 * 🔴 **그러면서 판정은 저쪽과 같은 것을 쓴다** — 열쇠를 가르는 규칙은
 * `parseDismissalKey` 하나이고(「첫 `:` 에서만 가른다」가 거기 적혀 있다),
 * 아는 시스템인지는 `NOTIFICATION_SOURCE_PATHS` 하나가 말한다. 베껴 적으면
 * 한쪽만 고치는 날 「사이트에서 지우면 되는데 포털에서 지우면 안 된다」가
 * 되고, 그 어긋남은 신고로만 드러난다.
 *
 * ── 🔴 왜 가리는가 — 적히는 칸이 `text` 라서 ───────────────────────────────
 * `notification_dismissals.notification_key` 는 길이 제한이 없는 `text` 다.
 * 안 가리면 로그인한 사람이 제 손으로 아무 글자나 그 표에 밀어 넣을 수 있다
 * (제 행에만 쌓이지만, 쌓이는 것은 쌓이는 것이다). 확인(✓) 쪽은 포털이 제
 * 목록에서 그 줄을 **찾아야** 적으므로(acknowledgements.ts 의
 * acknowledgementRowsFor) 이 가림이 없어도 쓰레기가 안 쌓이는데, 그래도 같은
 * 함수를 통과시킨다 — 두 길이 같은 잣대를 쓰면 뒷날 한쪽만 느슨해질 자리가
 * 없다.
 *
 * 🔴 **이 파일은 DB 도 세션도 모른다.** 「누구의 지움인가」는 여기서 정하지
 * 않는다 — 그것은 서버가 제 세션에서 읽는다(서버 액션 머리말). 여기서 하는
 * 일은 「이 글자가 열쇠 모양인가」뿐이고, 그래서 시험이 붙는다.
 * ============================================================================
 */

/**
 * 종이 돌려준 줄에서 **쓸 수 있는 열쇠**를 꺼낸다. 아니면 `null`.
 *
 * 🔴 **던지지 않는다.** 무엇이 와도 값이 나온다 — `null`·숫자·배열·프로토타입만
 * 가진 객체까지. 던지면 ✕ 를 누른 사람의 화면에 빨간 오류가 뜬다.
 *
 * 🔵 앞뒤 공백을 턴다. 저쪽 `readDismissalKeys` 가 같은 자리에서 같은 일을
 * 한다 — 열쇠는 글자로 날아다니므로 공백 한 칸이 붙어 오는 길이 있다.
 */
export function readBellKey(item: unknown): string | null {
  // 🔴 `typeof null === "object"` 라 null 을 따로 막는다. 배열도 객체지만
  //    `key` 칸이 없어 아래에서 떨어진다.
  if (typeof item !== "object" || item === null) return null;

  // 🔵 「있는가」가 아니라 **꺼내서 타입을 본다.** `"key" in item` 으로 물으면
  //    값이 숫자든 객체든 통과해 아래 `.trim()` 에서 터진다.
  const raw = (item as { key?: unknown }).key;
  if (typeof raw !== "string") return null;

  const key = raw.trim();
  if (key === "") return null;

  const parsed = parseDismissalKey(key);
  // 🔴 `in` 이 아니라 `Object.hasOwn` 이다. `in` 은 프로토타입까지 보기 때문에
  //    `constructor:x`·`toString:x` 같은 열쇠가 **등록된 시스템인 척 통과한다.**
  //    저쪽 readDismissalKeys 가 같은 까닭으로 같은 줄을 갖고 있다.
  if (!parsed || !Object.hasOwn(NOTIFICATION_SOURCE_PATHS, parsed.clientId)) return null;

  return key;
}
