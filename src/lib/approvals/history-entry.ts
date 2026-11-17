import { screenApprovalKey } from "./screen-inbox";

/**
 * ============================================================================
 * 세 집이 보낸 결재 **내역**을 읽는다 — 여덟 칸을 받아 열한 칸으로 올린다
 * ============================================================================
 * 세 집(A/S · 재고관리 · 휴가)이 **글자 그대로 같은 계약**으로 보낸다:
 *
 *   { entries: [ { id, subject, approvalName, decidedAt, decision,
 *                  relation, counterpartName, href } ] }
 *
 * 🔴 **포털이 셋을 붙인다** — `key` · `sourceId` · `sourceName`. 각 집은 제 이름을
 * 모르고, `id` 도 **그 집 안에서만** 유일하다. 승인함이 「어느 시스템 결재인가」를
 * 그릴 수 있는 것도, 두 집이 같은 `id` 를 줘도 줄이 안 겹치는 것도 이 셋 덕이다.
 *
 * ── 🔴 `relation` 은 **네 값을 다 받을 준비**가 돼 있어야 한다 ───────────────
 * A/S 는 `UNKNOWN` 을 **안 낸다**(그 집은 누른 사람을 칸에 적어 두고 표의 CHECK 가
 * 빈 값을 막는다). 🔴 **재고관리와 휴가는 낸다** — 재고관리는 `decided_by_sub` 칸이
 * 생긴 2026-10-21 이전 줄이고, 휴가는 누른 사람 이름이 안 풀리는 줄이다. 「A/S 에
 * 없으니 셋만 처리」로 좁히면 나머지 두 집의 옛 줄이 조용히 떨어진다.
 *
 * ── 🔴 버리는 줄과 그대로 올리는 줄 ────────────────────────────────────────
 * 틀은 결재함 쪽(screen-inbox.ts)을 따른다 — **줄을 함부로 버리지 않는다.** 조용히
 * 사라진 줄은 「그 기간에 결재한 게 없구나」로 읽히고, 아무도 신고하지 않는다.
 * 버리는 것은 **정직하게 그릴 수 없는 둘**뿐이고, 버린 수는 응답에 실어 올린다:
 *
 *  · `id` 가 없다 → `{client_id}:{id}` 열쇠를 지을 수 없다. 열쇠 없는 줄은 승인함이
 *    목록의 React key 로 쓸 것이 없어 어차피 못 그린다.
 *  · `decision` 이 `APPROVED`·`REJECTED` 둘 중 하나가 아니다 → **승인인지 반려인지
 *    모르는 결재 줄**이다. 기본값을 고르는 순간 포털이 거짓말을 한다 — 「반려를
 *    승인으로 그렸다」는 이 화면에서 가장 비싼 오류다.
 *
 * 🔴 **나머지 여섯 칸은 모양이 틀려도 버리지 않고 빈 글자로 올린다.** 제목이 비어도
 * 「2026-11-03 · 승인」은 사람에게 뜻이 있다. 🔵 `relation` 만 예외로 모르는 값이
 * 오면 `UNKNOWN` 으로 접는다 — 계약에 없는 글자를 올리면 승인함이 그 줄에 붙일
 * 이름표를 못 고르고, 그때 줄이 **통째로** 안 그려진다.
 *
 * ── 🔵 `javascript:` 같은 주소를 여기서 거르지 않는다 ──────────────────────
 * 결재함 쪽과 같은 판단이다. 그리는 쪽이 막고 세며, 포털은 그 주소를 제 화면에
 * 쓰지 않는다.
 * ============================================================================
 */

/**
 * 🔴 **보는 사람 기준**의 네 값. 세 집의 계약 글자 그대로다.
 *
 *  · `SELF`        내가 내 자리를 눌렀다 (상대 없음)
 *  · `ON_BEHALF`   내가 **남을 대신해** 눌렀다 (상대 = 자리 주인)
 *  · `BY_DELEGATE` **내 자리를 남이** 눌렀다 (상대 = 누른 사람)
 *  · `UNKNOWN`     누른 사람이 **안 적힌 옛 줄** (상대 없음)
 */
export const PORTAL_APPROVAL_HISTORY_RELATIONS = [
  "SELF",
  "ON_BEHALF",
  "BY_DELEGATE",
  "UNKNOWN",
] as const;

export type PortalApprovalHistoryRelation = (typeof PORTAL_APPROVAL_HISTORY_RELATIONS)[number];

/** 내역에 설 수 있는 결정은 둘뿐이다. 🔴 「올라와 있는 건」은 내역이 아니다. */
export const PORTAL_APPROVAL_HISTORY_DECISIONS = ["APPROVED", "REJECTED"] as const;

export type PortalApprovalHistoryDecision = (typeof PORTAL_APPROVAL_HISTORY_DECISIONS)[number];

/** 승인함에 서는 내역 한 줄. 🔴 **이 열한 칸이 승인함과의 계약이다.** */
export type PortalApprovalHistoryEntry = {
  /**
   * 목록 전체에서 유일한 열쇠 — `{client_id}:{id}`. 🔴 **포털이 붙인다.**
   *
   * 🔴 **결재함이 쓰는 꼴과 같은 함수로 짓는다**(screen-inbox.ts 의
   * `screenApprovalKey`). 같은 결재가 승인함의 「결재할 건」과 「내역」에 차례로
   * 서는데 꼴이 갈라지면 그 둘이 같은 것임을 맞춰 볼 길이 없어진다. 베끼지 않고
   * 그 함수를 부르는 것이 그 성질을 지키는 유일한 방법이다.
   */
  key: string;
  /** 어느 시스템에서 왔는가(`client_id`). 🔴 포털이 붙인다. */
  sourceId: string;
  /** 사람이 읽는 시스템 이름. 🔴 포털이 붙인다 — `clients` 표의 이름이다. */
  sourceName: string;
  /** 그 집 안에서 이 결재 줄을 가리키는 값. */
  id: string;
  /** 사람이 알아보는 글자 — 인수번호 · 발행번호 · 누구의 무슨 휴가. */
  subject: string;
  /** 무슨 결재인가 — 「수리 검수 승인」·「부품 불출」·「연차 신청」… */
  approvalName: string;
  /** ISO 8601. 🔴 **결정** 시각이다 — 올린 시각이 아니다. */
  decidedAt: string;
  decision: PortalApprovalHistoryDecision;
  /** 🔴 보는 사람 기준(위 유니온). */
  relation: PortalApprovalHistoryRelation;
  /** 🔴 **누가 상대인가는 `relation` 이 정한다.** 상대가 없는 둘은 `null`. */
  counterpartName: string | null;
  /** 🔴 **절대 주소.** 눌러서 그 집으로 간다. 손대지 않는다. */
  href: string;
};

export type ParsedApprovalHistory = {
  entries: PortalApprovalHistoryEntry[];
  /**
   * **정직하게 그릴 수 없어 버린 줄의 수**(머리말의 둘).
   *
   * 🔴 **응답에 실어 올린다** — 결재함 쪽은 같은 숫자를 로그로만 남기는데, 그것은
   * 승인함에 **제 몫의 검사기**가 이미 있어 「N건을 그리지 못했습니다」를 띄우기
   * 때문이다(screen-inbox.ts 의 그 문단). 내역은 포털이 먼저 버리므로 여기서 수를
   * 안 올리면 그 줄은 **흔적도 없이** 사라진다.
   */
  dropped: number;
  /**
   * 계약에 없는 `relation` 글자가 와서 `UNKNOWN` 으로 접은 줄의 수.
   *
   * 🔵 응답에는 담지 않는다 — 줄은 **그려지고** 뜻도 크게 틀리지 않아 사람이 볼
   * 까닭이 없다. 대신 부르는 쪽이 서버 로그에 한 줄 남긴다(history-gather.ts):
   * 이 수가 0 이 아니면 그 집이 갈래를 늘렸는데 포털이 안 따라간 것이다.
   */
  unknownRelations: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 글자가 아니면 **빈 글자**로. 🔴 줄을 버리지 않는다(머리말).
 *
 * 타입이 `string` 이라고 적어 놓고 숫자나 객체를 흘려 보내면, 그 값이 승인함의
 * 어느 줄에서 터질지 알 수 없다. 빈 글자로 바꿔 두면 그 칸만 비어 보인다.
 */
function textOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 이름이 글자가 아니거나 비어 있으면 `null`. 「모른다」를 적을 자리가 계약에 있다. */
function nameOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isRelation(value: unknown): value is PortalApprovalHistoryRelation {
  return (
    typeof value === "string" &&
    (PORTAL_APPROVAL_HISTORY_RELATIONS as readonly string[]).includes(value)
  );
}

function isDecision(value: unknown): value is PortalApprovalHistoryDecision {
  return (
    typeof value === "string" &&
    (PORTAL_APPROVAL_HISTORY_DECISIONS as readonly string[]).includes(value)
  );
}

/**
 * 응답 본문 하나를 읽는다. 🔴 **던지지 않는다.**
 *
 * 모양이 아예 다르면 `null` 이고, 부르는 쪽이 「못 물어봤다」(`failed`)와 같이
 * 다룬다. 200 인데 모양이 다른 것을 「내역이 없다」로 읽으면 그 집의 결재 행적이
 * 아무 표시 없이 사라진다.
 *
 * @param source 포털이 붙이는 두 칸의 출처. `clients` 표에서 온 값이고, 저쪽이 보낸
 *               본문에는 들어 있지 않다 — 들어 있더라도 쓰지 않는다(한 집이 제
 *               이름을 남의 이름으로 적어 보낼 수 있다).
 */
export function parsePortalApprovalHistory(
  body: unknown,
  source: { clientId: string; name: string }
): ParsedApprovalHistory | null {
  if (!isRecord(body)) return null;
  // 🔴 칸 이름이 `entries` 다 — 결재함의 `items` 가 아니다. 세 집이 그렇게 맞췄다.
  if (!Array.isArray(body.entries)) return null;

  const entries: PortalApprovalHistoryEntry[] = [];
  let dropped = 0;
  let unknownRelations = 0;

  for (const raw of body.entries) {
    if (!isRecord(raw)) {
      dropped += 1;
      continue;
    }

    const id = nonEmptyString(raw.id);
    if (id === null) {
      // 열쇠를 지을 수 없다(머리말).
      dropped += 1;
      continue;
    }

    if (!isDecision(raw.decision)) {
      // 🔴 승인인지 반려인지 모르는 줄. 기본값을 고르면 포털이 거짓말을 한다.
      dropped += 1;
      continue;
    }

    const relation = isRelation(raw.relation) ? raw.relation : "UNKNOWN";
    if (!isRelation(raw.relation)) unknownRelations += 1;

    entries.push({
      // ── 🔴 포털이 붙이는 셋. ──
      key: screenApprovalKey(source.clientId, id),
      sourceId: source.clientId,
      sourceName: source.name,
      // ── 저쪽이 보낸 여덟. 🔴 글자를 고치지 않는다. ──
      id,
      subject: textOrEmpty(raw.subject),
      approvalName: textOrEmpty(raw.approvalName),
      decidedAt: textOrEmpty(raw.decidedAt),
      decision: raw.decision,
      relation,
      // 🔴 상대가 없는 갈래 둘은 이름이 와도 `null` 로 닫는다. 계약이 「상대 없음」
      //    이라고 못 박은 자리라(세 집의 같은 주석), 이름이 함께 온 줄은 저쪽의
      //    실수다. 그대로 그리면 「내가 나를 대신했다」 같은 줄이 선다.
      counterpartName:
        relation === "SELF" || relation === "UNKNOWN" ? null : nameOrNull(raw.counterpartName),
      href: textOrEmpty(raw.href),
    });
  }

  return { entries, dropped, unknownRelations };
}

/**
 * 차례를 재는 값. 못 읽는 글자는 **맨 아래**로 보낸다.
 *
 * 🔴 **글자 비교로 세우지 않는다.** 세 집이 보내는 `decidedAt` 의 시간대 표기가
 * 같다는 보장이 계약에 없다 — 한 집이 `+09:00` 으로 보내는 날 사전순과 시간순이
 * 갈라지고, 증상은 「목록의 차례가 어딘가 이상하다」 하나뿐이다.
 *
 * 🔵 못 읽는 줄을 **버리지 않고 아래로** 보내는 까닭은 머리말과 같다 — 날짜만
 * 깨졌을 뿐 제목도 결정도 사람에게 뜻이 있다.
 */
function decidedAtOrder(value: string): number {
  const at = Date.parse(value);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/**
 * 결정이 **늦은 것부터**. 🔴 **세 집을 합친 뒤 다시 세우는 자리다.**
 *
 * 각 집은 제 안에서 세워 보내지만, 셋을 이어 붙이면 「A/S 11월분 전부 → 재고관리
 * 11월분 전부」처럼 **집별로 뭉친 목록**이 된다. 사람이 묻는 것은 「내가 11월에 한
 * 결재」이지 「집집마다의 11월」이 아니다.
 *
 * 같은 시각이면 `key` 로 동점을 깬다 — 새로고침할 때마다 줄이 자리를 바꾸면
 * 사람이 같은 줄을 두 번 읽는다. 🔵 `key` 에는 `client_id` 가 앞에 붙어 있어 두
 * 집이 같은 시각에 결재된 줄을 내도 차례가 흔들리지 않는다.
 */
export function compareApprovalHistoryNewestFirst(
  a: PortalApprovalHistoryEntry,
  b: PortalApprovalHistoryEntry
): number {
  const left = decidedAtOrder(a.decidedAt);
  const right = decidedAtOrder(b.decidedAt);
  if (left !== right) return right - left;
  return a.key.localeCompare(b.key);
}
