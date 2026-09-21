import type {
  PortalSettingsChange,
  PortalSettingsKind,
  PortalSettingsRole,
} from "./settings";

/**
 * ============================================================================
 * 표에서 「바뀐 줄」만 골라낸다 — 화면과 저장 사이의 유일한 계산
 * ============================================================================
 * 알림 설정 화면은 포털의 다른 관리 화면과 같은 틀이다: 자바스크립트 없이 도는
 * 평범한 폼(admin/users 의 그 주석). 그래서 「무엇이 바뀌었나」는 브라우저가 아니라
 * **여기서** 정해진다.
 *
 * 🔴 **역할 이름도 종류 이름도 여기 적지 않는다.** 이 파일이 아는 것은 「받은
 * 표」와 「보낸 폼」둘뿐이고, 무엇이 들었는지는 그 시스템이 정한다(설계서 F-4).
 * 목록을 코드에 적는 순간 A/S 가 역할을 하나 늘릴 때 포털을 고쳐 배포해야 한다.
 *
 * ── 🔴 잠긴 역할은 **아예 싣지 않는다** ────────────────────────────────────
 * 그냥 「보내도 무시되겠지」가 아니다. A/S 의 저장 함수는 잠긴 역할에 거짓이
 * 실려 오면 **그 요청 전체를 거절한다**(mutations/notification-settings.ts 의 4번
 * ——「최고관리자가 받는 알림은 끌 수 없습니다」). 잠긴 칸은 화면에서 disabled 라
 * 브라우저가 보내지 않으므로 값이 늘 거짓으로 읽히고, 그것을 그대로 담으면
 * **같이 바꾼 다른 일곱 줄까지 통째로 저장되지 않는다.**
 *
 * 빼는 것이 안전한 근거도 저쪽에 적혀 있다 — 「빠진 역할은 건드리지 않는다(= 지금
 * 값 그대로)」. 즉 잠긴 칸은 보내지 않는 것이 곧 「그대로 두라」는 뜻이다.
 *
 * ── 체크가 없으면 꺼짐이다 ────────────────────────────────────────────────
 * HTML 은 체크되지 않은 칸을 보내지 않는다. 그래서 「보냈나(has)」가 곧 값이다.
 * 대신 줄 자체가 화면에 있었는지는 알 수 없게 되므로, 줄마다 표시(KIND_MARKER_FIELD)
 * 를 하나씩 숨겨 함께 보낸다. 그 표시가 없는 종류는 **화면이 그린 적 없는 종류**
 * 이고(화면을 연 뒤 저쪽이 새로 만든 것), 사람이 뜻을 정한 적 없으므로 건드리지
 * 않는다.
 * ============================================================================
 */

/** 화면에 그려진 종류 한 줄마다 하나씩 실려 오는 표시. */
export const KIND_MARKER_FIELD = "kind";

/** 종류 스위치 한 칸. */
export function enabledFieldName(kind: string): string {
  return `enabled:${kind}`;
}

/** 종류 × 역할 한 칸. */
export function receivesFieldName(kind: string, role: string): string {
  return `receives:${kind}:${role}`;
}

/**
 * 폼에서 읽는 데 필요한 것만. 시험이 FormData 를 그대로 넘길 수 있고, 이
 * 함수가 폼의 나머지(clientId 따위)를 볼 수 없다는 것도 타입으로 드러난다.
 */
export type SubmittedForm = Pick<FormData, "has" | "getAll">;

/**
 * 「지금 그 시스템의 값」과 「사람이 보낸 표」를 견줘 **달라진 종류만** 만든다.
 *
 * 🔴 견주는 상대는 화면을 그릴 때의 값이 아니라 **저장 직전에 다시 물어본 값**
 * 이다(부르는 쪽이 그렇게 넘긴다). 화면을 열어 둔 채 한참 있다가 저장하는 일이
 * 흔한데, 그 사이 저쪽에서 달라진 줄까지 되돌려 놓으면 안 된다.
 *
 * 바뀐 종류에는 **잠기지 않은 역할 전부**를 싣는다 — 그 가운데 안 바뀐 칸도
 * 함께다. PUT 은 「이 종류의 상태를 이렇게 맞춰라」이고, 저쪽은 값이 같은 칸에
 * 대해서는 아무것도 하지 않는다(changedCount 에도 세지 않는다).
 */
export function diffSubmittedSettings(params: {
  form: SubmittedForm;
  roles: readonly PortalSettingsRole[];
  kinds: readonly PortalSettingsKind[];
}): PortalSettingsChange[] {
  const onScreen = new Set(
    params.form
      .getAll(KIND_MARKER_FIELD)
      .filter((value): value is string => typeof value === "string")
  );
  const editableRoles = params.roles.filter((role) => role.editable);

  const changes: PortalSettingsChange[] = [];

  for (const row of params.kinds) {
    if (!onScreen.has(row.kind)) continue;

    const enabled = params.form.has(enabledFieldName(row.kind));
    let changed = enabled !== row.enabled;

    const roles: Record<string, boolean> = {};
    for (const role of editableRoles) {
      // 받은 표에 그 칸이 없으면 화면에도 없었다. 없는 칸을 거짓으로 채워
      // 보내면 저쪽에서 **끈 것**이 된다.
      //
      // hasOwn 으로 보는 까닭: 역할 코드는 저쪽이 보낸 글자다. `toString` 같은
      // 이름이 오면 대괄호 조회는 Object 의 것을 집어 와 「칸이 있다」가 된다.
      if (!Object.hasOwn(row.roles, role.code)) continue;
      const cell = row.roles[role.code];

      const receives = params.form.has(receivesFieldName(row.kind, role.code));
      if (receives !== cell.receives) changed = true;
      roles[role.code] = receives;
    }

    if (changed) changes.push({ kind: row.kind, enabled, roles });
  }

  return changes;
}
