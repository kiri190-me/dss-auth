/**
 * ============================================================================
 * 저쪽이 보낸 결재함을 읽는다 — 🔴 **열쇠와 갈래만 들여온다**
 * ============================================================================
 * 세 시스템은 줄마다 일곱 칸을 보낸다:
 *
 *   { id, kind, kindLabel, subject, detail, requestedAt, href }
 *
 * 이 파일이 그중 **둘(`id`·`kind`)만** 꺼낸다. 나머지 다섯은 여기서 버려지고
 * 포털의 어느 변수에도 담기지 않는다.
 *
 * ── 🔴 왜 버리는가 — 이 조각에서 가장 중요한 울타리 ───────────────────────
 * 메일 본문에 **결재의 내용을 싣지 않기로 했다**(2026-10-23 결정). 까닭:
 *  · 메일은 외부 호스팅(smtp.cafe24.com)을 거치고 **본문이 영구히 남는다.**
 *  · 직원이 개인 메일로 자동 전달을 걸어 두면 사내 결재 내용이 그대로 밖으로
 *    나간다 — 막을 길이 없다.
 *
 * 「본문을 만들 때 조심한다」로는 그 약속이 지켜지지 않는다. 한 사람이 언젠가
 * 「어느 건인지 알면 편하지 않나」 하고 `subject` 를 한 줄 더하는 날, 그것은
 * 버그처럼 보이지도 않는다. 그래서 **아예 들여오지 않는다** — 본문을 만드는
 * 자리(approvals/mail-message.ts)에 그 값이 존재하지 않으면 실을 수가 없다.
 *
 * 🔵 `kindLabel` 도 버린다. 사람이 읽는 갈래 이름은 포털이 제 상수에서 쓴다
 * (approvals/kinds.ts 의 `label`) — 저쪽이 보낸 글자를 메일에 옮기지 않으면,
 * 한 시스템이 뚫렸을 때 메일 본문으로 글자를 밀어 넣는 길까지 함께 닫힌다.
 *
 * ── 🔴 「결재할 것이 없다」와 「물어볼 수 없다」를 가른다 ──────────────────
 * 휴가 관리는 계정과 직원이 이어지지 않은 사람에게
 * `{"items":[],"count":0,"unavailable":"employee_not_linked"}` 를 준다. 그것은
 * **「결재할 게 없다」가 아니다** — 이을 것이 안 이어져 있다는 신고다. 아래
 * `unavailable` 로 구별해 올리고, 작업 기록에 따로 센다(approvals/run.ts).
 * ============================================================================
 */

/** 포털이 들여오는 전부. 🔴 칸을 늘리지 마라 — 늘리는 순간 위 울타리가 열린다. */
export type ApprovalInboxItem = {
  /** 저쪽 `items[].id` 그대로. 보낸 기록의 열쇠가 된다. */
  id: string;
  /** 저쪽 `items[].kind` 그대로. 갈래 스위치와 맞춰 본다. */
  kind: string;
};

export type ParsedApprovalInbox = {
  items: ApprovalInboxItem[];
  /**
   * 「물어보기는 했는데 답할 수 없는 사정」. 지금은 휴가 관리의
   * `employee_not_linked` 하나다.
   *
   * 🔵 글자를 미리 정해 두지 않고 **받은 그대로** 담는다. 사정이 하나 더 생기는
   * 날 포털을 고치지 않아도 기록에 남는다 — 모르는 글자를 버리면 그 사정은
   * 「결재 0건」과 구별되지 않는다.
   */
  unavailable?: string;
};

/** 빈 답. 🔴 오류가 아니다 — 결재할 것이 없는 사람이 대부분이다. */
export const EMPTY_APPROVAL_INBOX: ParsedApprovalInbox = { items: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 응답 본문 하나를 읽는다. 🔴 **던지지 않는다.**
 *
 * 모양이 아예 다르면 `null` 이다 — 부르는 쪽이 「못 물어봤다」와 같이 다룬다.
 * 반대로 **줄 하나가 깨진 것은 그 줄만 버린다**: 다섯 건 중 한 건의 `id` 가
 * 비었다고 나머지 넷의 메일까지 멎으면 손해가 더 크다. 버린 줄 수는 돌려주지
 * 않지만, 버리는 것 자체가 드문 일이라 그보다는 **깨진 줄을 보낸 시스템이
 * 고쳐질 때까지 나머지가 도는 것**이 중요하다.
 */
export function parseApprovalInbox(body: unknown): ParsedApprovalInbox | null {
  if (!isRecord(body)) return null;
  if (!Array.isArray(body.items)) return null;

  const items: ApprovalInboxItem[] = [];
  for (const raw of body.items) {
    if (!isRecord(raw)) continue;
    const id = nonEmptyString(raw.id);
    const kind = nonEmptyString(raw.kind);
    if (id === null || kind === null) continue;
    // 🔴 여기서 꺼내는 것은 둘뿐이다(머리말). `...raw` 로 펼치지 마라.
    items.push({ id, kind });
  }

  const unavailable = nonEmptyString(body.unavailable);
  return unavailable === null ? { items } : { items, unavailable };
}
