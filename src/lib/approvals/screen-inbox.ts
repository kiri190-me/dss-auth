/**
 * ============================================================================
 * 저쪽이 보낸 결재함을 **화면용으로** 읽는다 — 일곱 칸을 다 들여온다
 * ============================================================================
 * 세 시스템은 줄마다 일곱 칸을 보낸다:
 *
 *   { id, kind, kindLabel, subject, detail, requestedAt, href }
 *
 * 🔴 **메일 쪽 inbox.ts 와 짝이 아니라 반대다.** 저쪽은 일곱 중 둘(`id`·`kind`)만
 * 들여오고 다섯을 버리는데, 그것은 **울타리**다 — 메일 본문에 결재 내용을 싣지
 * 않기로 했고(2026-10-23 결정), 본문을 만드는 자리에 그 값이 **존재하지 않으면**
 * 실을 수가 없기 때문이다. 저 파일의 머리말에 까닭이 길게 적혀 있다.
 *
 * ── 🔴 그래서 저 파일을 넓히지 않고 이 파일을 새로 두었다 ─────────────────
 * 화면(통합 승인함 `dss-approvals`)에는 일곱 칸이 다 필요하다. 제목도 보탬도
 * 기다린 시각도 없으면 그릴 것이 없다. 그렇다고 `inbox.ts` 에 칸을 더하면 위
 * 울타리가 **메일 쪽에서도** 열린다 — 들여온 값은 같은 변수에 담기고, 담기는
 * 순간 「본문을 만들 때 조심한다」로 지켜야 하는 약속이 된다. 그 약속은 사람이
 * 지키는 것이라 언젠가 깨지고, 깨져도 버그처럼 보이지 않는다.
 *
 * 🔵 두 길은 들여오는 것 말고도 다르다: 상한이 다르고(저쪽 5초 · 이쪽 1.5초 —
 * screen-gather.ts), 답을 캐시하지 않으며, 「물어볼 수 없다」를 화면에 글자로
 * 말한다. 같은 함수에 갈래를 내는 것보다 나란히 두는 편이 읽기 쉽다.
 *
 * ── 🔴 버리는 줄은 **열쇠를 지을 수 없는 줄 하나뿐**이다 ──────────────────
 * `id` 가 없으면 `{client_id}:{id}` 열쇠를 만들 수 없어 그 줄만 버린다. 나머지
 * 여섯은 **모양이 틀려도 버리지 않고 빈 글자로 올린다.** 까닭:
 *
 *  · 승인함에는 **제 몫의 검사기가 이미 있다.** 열 칸 가운데 `detail` 말고
 *    하나라도 비면 그 줄을 빼고 **「N건을 그리지 못했습니다」를 화면에 띄운다**
 *    (그쪽 portal.ts 의 toApprovalItem · view.ts 의 approvalTroubles).
 *  · 포털이 여기서 먼저 버리면 그 안내가 **뜨지 않는다.** 줄은 사라지고 아무도
 *    신고하지 않는다 — 「결재할 게 없네」로 읽히기 때문이다. 이 저장소에서
 *    가장 나쁜 실패의 모양이고(merge.ts 의 degraded 주석), 결재에서는 더 나쁘다.
 *
 * 🔵 `javascript:` 같은 주소를 여기서 거르지 않는 것도 같은 이유다. 그리는 쪽이
 * 막고(승인함의 isCrossSystemHref) 센다. 포털은 그 주소를 제 화면에 쓰지 않는다.
 * ============================================================================
 */

/** 승인함 한 줄. 🔴 **이 열 칸이 승인함과의 계약이다**(그쪽 ApprovalInboxItem). */
export type ScreenApprovalItem = {
  /**
   * 목록 전체에서 유일한 열쇠 — `{client_id}:{id}`. 🔴 **포털이 붙인다.**
   *
   * 각 시스템의 `id` 는 그 시스템 안에서만 유일하다. 두 시스템이 같은 id 를 줄
   * 수 있고, 그대로 React key 로 쓰면 승인함이 줄을 잘못 지운다. 🔵 종이 쓰는
   * 열쇠와 **같은 꼴**이다(notifications/merge.ts) — 같은 결재가 종과 승인함에
   * 함께 뜨는데 열쇠가 다르면 그 둘이 같은 것임을 아무도 맞춰 볼 수 없다.
   */
  key: string;
  /** 어느 시스템에서 왔는가(`client_id`). 🔴 포털이 붙인다. */
  sourceId: string;
  /** 사람이 읽는 시스템 이름. 🔴 포털이 붙인다 — `clients` 표의 이름이다. */
  sourceName: string;
  /** 그 시스템 안에서 이 결재건을 가리키는 값. */
  id: string;
  /** 기계가 읽는 갈래(`REPAIR_INSPECTION` 등 다섯 — kinds.ts). */
  kind: string;
  /**
   * 사람이 읽는 갈래 이름.
   *
   * 🔴 **저쪽이 보낸 글자를 그대로 나른다.** kinds.ts 의 `label` 로 갈아 끼우지
   * 않는다 — 그 상수는 **메일 본문**을 위한 것이고(저쪽 글자를 메일에 옮기지
   * 않으려고 둔 울타리다), 화면은 어휘의 주인인 그 시스템의 말을 보여 주는 쪽이
   * 맞다. 포털이 모르는 갈래가 하나 늘어도 승인함에는 제 이름으로 뜬다.
   */
  kindLabel: string;
  /** 한 줄 제목(인수번호 · 견적서 발행번호 …). */
  subject: string;
  /** 한 줄 보탬. 🔵 **비어 있을 수 있다** — A/S 의 접수건 결재가 빈 글자로 온다. */
  detail: string;
  /** ISO 8601. 승인함이 이 값으로 **오래 기다린 순**으로 세운다. */
  requestedAt: string;
  /** 🔴 **절대 주소.** [승인하기]가 가는 곳이다. 손대지 않는다. */
  href: string;
};

export type ParsedScreenInbox = {
  items: ScreenApprovalItem[];
  /**
   * 열쇠를 지을 수 없어 **버린 줄의 수**. 🔴 응답에는 담기지 않는다 — 부르는 쪽이
   * 서버 로그에 한 줄 남기는 데 쓴다(screen-gather.ts).
   *
   * 🔵 승인함이 세는 `unreadable` 과 **다른 수**다. 저쪽은 **저쪽이** 못 그린 줄을
   * 세어 화면에 말하고, 이 수는 포털까지 오지도 못한 줄이다. 둘을 한 숫자로 합칠
   * 자리가 응답 모양에 없어서(승인함과의 계약은 칸 넷이다) 로그로 남긴다.
   */
  dropped: number;
  /**
   * 「물어보기는 했는데 답할 수 없는 사정」. 지금은 휴가 관리의
   * `employee_not_linked` 하나다.
   *
   * 🔵 메일 쪽과 같이 **받은 그대로** 담는다. 글자를 미리 정해 두면 사정이 하나
   * 더 생기는 날 그것이 「결재 0건」과 구별되지 않는다. 승인함도 같은 선택을
   * 했다(그쪽 toSourceStatus 의 reason).
   */
  unavailable?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 글자가 아니면 **빈 글자**로 만든다. 🔴 줄을 버리지 않는다(머리말).
 *
 * 숫자나 객체가 와도 여기서 멈춘다 — 타입이 `string` 이라고 적어 놓고 아닌 값을
 * 흘려 보내면, 틀린 값이 포털을 지나 승인함의 검사기까지 가는 동안 어디서
 * 터질지 알 수 없다. 빈 글자로 바꿔 두면 저쪽이 **그 줄만** 빼고 수를 센다.
 */
function textOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 목록 전체에서 유일한 열쇠.
 *
 * 🔴 **종이 쓰는 꼴과 같아야 한다**(notifications/merge.ts 의 parseSourceFeed —
 * `${source.clientId}:${id}`). 같은 결재가 종과 승인함에 함께 뜨므로, 꼴이
 * 갈라지면 두 화면의 같은 줄을 맞춰 볼 길이 없어진다. 그 성질은 시험이 두 함수를
 * 맞대어 지킨다(screen-inbox.test.ts).
 */
export function screenApprovalKey(clientId: string, id: string): string {
  return `${clientId}:${id}`;
}

/**
 * 응답 본문 하나를 읽는다. 🔴 **던지지 않는다.**
 *
 * 모양이 아예 다르면 `null` 이다 — 부르는 쪽이 「못 물어봤다」(`failed`)와 같이
 * 다룬다. 200 인데 모양이 다른 것을 「없다」로 읽으면 그 시스템의 결재가 아무
 * 표시 없이 사라진다.
 *
 * @param source 포털이 붙이는 두 칸의 출처. `clients` 표에서 온 값이고, 저쪽이
 *               보낸 본문에는 들어 있지 않다 — 들어 있더라도 쓰지 않는다(한
 *               시스템이 제 이름을 남의 이름으로 적어 보낼 수 있다).
 */
export function parseScreenApprovalInbox(
  body: unknown,
  source: { clientId: string; name: string }
): ParsedScreenInbox | null {
  if (!isRecord(body)) return null;
  if (!Array.isArray(body.items)) return null;

  const items: ScreenApprovalItem[] = [];
  let dropped = 0;

  for (const raw of body.items) {
    if (!isRecord(raw)) {
      dropped += 1;
      continue;
    }

    const id = nonEmptyString(raw.id);
    if (id === null) {
      // 🔴 열쇠를 지을 수 없는 줄. 여기서만 버린다 — 나머지 칸은 비어도 올린다.
      dropped += 1;
      continue;
    }

    items.push({
      // ── 🔴 포털이 붙이는 셋. 하나라도 빠지면 승인함이 그 줄을 버린다. ──
      key: screenApprovalKey(source.clientId, id),
      sourceId: source.clientId,
      sourceName: source.name,
      // ── 저쪽이 보낸 일곱. 🔴 고치지 않는다. ──
      id,
      kind: textOrEmpty(raw.kind),
      kindLabel: textOrEmpty(raw.kindLabel),
      subject: textOrEmpty(raw.subject),
      detail: textOrEmpty(raw.detail),
      requestedAt: textOrEmpty(raw.requestedAt),
      href: textOrEmpty(raw.href),
    });
  }

  const unavailable = nonEmptyString(body.unavailable);
  return unavailable === null ? { items, dropped } : { items, dropped, unavailable };
}
