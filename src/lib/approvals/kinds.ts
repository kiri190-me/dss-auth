/**
 * ============================================================================
 * 메일을 보낼 수 있는 **결재 갈래 다섯** — 그리고 「켜짐」을 읽는 규칙
 * ============================================================================
 * 세 시스템이 `GET /api/integration/approvals` 로 내주는 결재의 갈래다. 포털은
 * 이 목록을 **코드에 적어 둔다.** 알림 설정(종)에서 「종류 목록도 이름도 그
 * 시스템이 정한다」고 했던 것과 다른 길이고, 까닭이 있다:
 *
 *  · 승인함 통로에는 **설정 통로가 없다.** 종은 시스템마다
 *    `/api/integration/notification-settings` 로 「내가 내주는 종류는 이것들」을
 *    함께 보내 주지만, 결재 통로는 **결재건만** 보낸다. 관리자 화면에 스위치
 *    다섯을 그리려면 포털이 목록을 알아야 한다.
 *  · 🔴 그리고 그 화면은 **그 시스템이 죽어 있어도 떠야 한다.** 물어서 그리는
 *    구조면 A/S 가 꺼져 있는 동안 A/S 쪽 스위치 셋이 화면에서 사라지고, 관리자는
 *    「없어졌다」와 「못 물어봤다」를 구별할 수 없다.
 *
 * 🔴 **그래서 여기 적힌 글자는 세 시스템의 코드와 한 글자씩 맞아야 한다.**
 * 저장소가 셋이라 컴파일러가 잡아 주지 못하는 자리다(service-token.ts 의
 * `PORTAL_SERVICE_TOKEN_PURPOSES` 와 같은 성질). 갈래가 하나 늘면 이 상수에
 * 한 줄을 더하는 것이 그 일의 일부다 — 더하지 않으면 그 갈래는 **모르는 갈래**로
 * 떨어져 메일이 나가지 않고, 그 사실은 작업 기록의 `skippedUnknownKind` 에만
 * 남는다(approvals/plan.ts).
 *
 * ── 🔴 `label` 은 **메일 본문에 쓰는 유일한 말**이다 ──────────────────────
 * 저쪽도 `kindLabel` 을 함께 보내 주지만 **그 값을 메일에 싣지 않는다.** 메일
 * 본문은 포털이 가진 글자만으로 만든다 — 그래야 「본문에 저쪽 자료가 실릴
 * 길이 아예 없다」가 구조로 참이 된다(approvals/inbox.ts 가 `id` 와 `kind` 외에
 * 아무것도 들여오지 않는 것과 한 쌍이다).
 * ============================================================================
 */

/** 갈래 하나. */
export type ApprovalMailKindEntry = {
  /** `clients.client_id`. 🔴 토큰의 aud 이자 설정 표의 열쇠 한 조각이다. */
  clientId: string;
  /** 저쪽이 보내는 `kind` 글자 그대로. */
  kind: string;
  /** 사람이 읽는 갈래 이름. 🔴 관리자 화면과 **메일 본문**이 이 글자를 쓴다. */
  label: string;
  /**
   * 관리자 화면에서 스위치를 묶어 보여 줄 때 쓰는 시스템 이름.
   *
   * 🔵 `clients.name` 을 쓰지 않는 까닭은 위 머리말과 같다 — 이 화면은 그
   * 시스템에 물어보지 않고 그려야 한다. DB 에 있는 이름과 다를 수 있지만,
   * 여기서 가리키는 것은 「어느 집의 결재인가」뿐이다.
   */
  systemLabel: string;
};

/**
 * 🔴 **차례가 곧 화면과 메일 본문의 차례다.** 시스템별로 묶여 있고, A/S 안에서는
 * 결재가 일어나는 순서(검수 → 출하 → 견적서)로 둔다.
 */
export const APPROVAL_MAIL_KINDS: readonly ApprovalMailKindEntry[] = [
  {
    clientId: "rf-service-system",
    kind: "REPAIR_INSPECTION",
    label: "접수건 검수 결재",
    systemLabel: "A/S 관리",
  },
  {
    clientId: "rf-service-system",
    kind: "FINAL_SHIPMENT",
    label: "접수건 최종 출하 결재",
    systemLabel: "A/S 관리",
  },
  {
    clientId: "rf-service-system",
    kind: "QUOTE_APPROVAL",
    label: "견적서 결재",
    systemLabel: "A/S 관리",
  },
  {
    clientId: "dss-inventory",
    kind: "PART_ISSUE_APPROVAL",
    label: "부품 불출 결재",
    systemLabel: "재고 관리",
  },
  {
    clientId: "dss-leave",
    kind: "LEAVE_REQUEST",
    label: "휴가 신청 결재",
    systemLabel: "휴가 관리",
  },
];

/**
 * 스위치 하나를 가리키는 열쇠 글자. `{client_id}:{kind}`.
 *
 * 🔵 **붙이기만 하고 다시 가르지 않는다.** `client_id` 에는 `:` 가 없지만
 * (`rf-service-system`), 가르는 함수를 두면 언젠가 `kind` 에 `:` 가 든 날
 * 조용히 틀린 쪽으로 갈린다. 필요한 것은 Map/Set 의 열쇠뿐이라 붙이는 쪽만 둔다.
 */
export function approvalKindKey(clientId: string, kind: string): string {
  return `${clientId}:${kind}`;
}

/** 아는 갈래인가. 모르는 갈래는 **메일을 보내지 않는다**(기본이 끔이므로). */
export function findApprovalMailKind(
  clientId: string,
  kind: string
): ApprovalMailKindEntry | undefined {
  return APPROVAL_MAIL_KINDS.find(
    (entry) => entry.clientId === clientId && entry.kind === kind
  );
}

/**
 * 이 갈래에 메일을 보내는가.
 *
 * 🔴 **기본값은 끔이다**(2026-10-23 결정). 켜진 것들의 열쇠 집합을 받아, 거기
 * 없으면 꺼진 것으로 본다 — DB 에 행이 없는 것과 `enabled=false` 인 행이 같은
 * 뜻이 되는 자리다(db/schema/approval-mail-kinds.ts).
 *
 * 🔴 **모르는 갈래도 꺼짐이다.** 집합에 들어올 수가 없기 때문인데, 그것이 맞다 —
 * 포털이 이름을 모르는 갈래는 메일 본문에 적을 말도 없다.
 */
export function isApprovalMailKindEnabled(
  enabledKeys: ReadonlySet<string>,
  clientId: string,
  kind: string
): boolean {
  return enabledKeys.has(approvalKindKey(clientId, kind));
}

/** 관리자 화면 체크박스 한 칸의 이름. */
export function approvalKindFieldName(clientId: string, kind: string): string {
  return `approval-mail:${approvalKindKey(clientId, kind)}`;
}

/** 저장할 줄 하나. */
export type ApprovalMailKindChange = {
  clientId: string;
  kind: string;
  enabled: boolean;
};

/** 폼에서 읽는 데 필요한 것만(notifications/purposes.ts 의 같은 모양). */
export type SubmittedApprovalKindForm = Pick<FormData, "get">;

/**
 * 「사람이 보낸 표」와 「지금 저장된 값」을 견줘 **달라진 스위치만** 만든다.
 * notifications/purposes.ts 의 `diffSubmittedPurposes` 와 같은 결이다.
 *
 * 🔴 **체크박스는 「없음 = 꺼짐」으로 읽는다.** 켜 둔 칸만 폼에 실리는 것이
 * 브라우저의 규칙이라, 안 실린 것을 「모름」으로 보면 **끄는 일이 영영 저장되지
 * 않는다.** 분류 고르개(`<select>`)와 다른 점이고, 다를 수밖에 없다.
 *
 * 🔵 그래서 이 함수는 **화면에 그려진 다섯 줄 전부**를 훑는다. 다섯은 코드가
 * 가진 상수라 「화면에 있었나」를 따로 실어 보낼 까닭이 없다(종 설정 표가
 * `KIND_MARKER_FIELD` 를 쓰는 것은 종류 목록이 저쪽 것이기 때문이다).
 */
export function diffSubmittedApprovalKinds(params: {
  form: SubmittedApprovalKindForm;
  /** 지금 켜져 있는 스위치들의 열쇠. 없는 것은 꺼짐이다. */
  enabledKeys: ReadonlySet<string>;
}): ApprovalMailKindChange[] {
  const changes: ApprovalMailKindChange[] = [];

  for (const entry of APPROVAL_MAIL_KINDS) {
    const submitted = params.form.get(approvalKindFieldName(entry.clientId, entry.kind)) !== null;
    const stored = isApprovalMailKindEnabled(params.enabledKeys, entry.clientId, entry.kind);
    if (submitted === stored) continue;
    changes.push({ clientId: entry.clientId, kind: entry.kind, enabled: submitted });
  }

  return changes;
}
