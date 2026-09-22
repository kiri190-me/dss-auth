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
 *
 * ── 🔴 사용을 끈 줄은 역할 칸이 **줄째로** 잠긴다 ──────────────────────────
 * A/S 화면과 같은 잠금이다(components/users/NotificationSettings.tsx). 끈 종류의
 * 역할을 고르면 무언가 달라졌다고 믿게 되지만 실제로는 아무에게도 가지 않는다.
 *
 * 🔴 그런데 **자바스크립트 없는 폼에서는 잠금이 곧 「안 실림」이다.** 브라우저가
 * disabled 칸을 빼고 보내므로 그 줄의 역할 칸은 전부 「체크 없음」으로 읽히고,
 * 그대로 담으면 **잠겨 있는 동안 역할 설정이 통째로 꺼진다** — 화면에 「끈 종류는
 * 역할 설정을 그대로 안고 기다린다」고 적어 둔 것과 정반대가 된다. 게다가 사람이
 * 사용을 **다시 켜서** 보내는 순간(역할 칸은 잠긴 채로 그려져 있다) 그 잘못이
 * 실제 저장으로 들어간다.
 *
 * 그래서 화면이 **잠근 줄에 표시 하나(ROLES_LOCKED_FIELD)를 함께 보낸다.** 위의
 * 잠긴 역할 규칙과 같은 뜻으로 읽는다 — 그 줄의 역할은 **아예 싣지 않는다**(=
 * 지금 값 그대로). 잠긴 칸의 값을 숨은 칸에 담아 되받지 않는 까닭은 저장 액션
 * 머리말에 적혀 있다(그 값이 곧 포털이 들고 있는 설정 사본이 된다).
 * ============================================================================
 */

/** 화면에 그려진 종류 한 줄마다 하나씩 실려 오는 표시. */
export const KIND_MARKER_FIELD = "kind";

/**
 * 🔴 역할 칸이 **잠긴 채** 그려진 종류. 값은 그 종류의 이름이고, 화면이 사용을
 * 끈 줄마다 하나씩 보낸다. 이 표시가 있는 종류의 역할 칸은 읽지 않는다.
 */
export const ROLES_LOCKED_FIELD = "rolesLocked";

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
  const rolesLocked = new Set(
    params.form
      .getAll(ROLES_LOCKED_FIELD)
      .filter((value): value is string => typeof value === "string")
  );
  const editableRoles = params.roles.filter((role) => role.editable);

  const changes: PortalSettingsChange[] = [];

  for (const row of params.kinds) {
    if (!onScreen.has(row.kind)) continue;

    const enabled = params.form.has(enabledFieldName(row.kind));
    let changed = enabled !== row.enabled;

    const roles: Record<string, boolean> = {};
    // 🔴 잠긴 채 그려진 줄의 역할 칸은 실려 오지 않는다. 「체크 없음」을 값으로
    // 읽으면 그 줄의 역할이 통째로 꺼진다 — 이 파일 머리말의 그 대목이다.
    for (const role of rolesLocked.has(row.kind) ? [] : editableRoles) {
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

/** 한 줄을 화면에 어떻게 그릴 것인가. 🔴 폼에 실리는 값이 곧 이 값이다. */
export type ShownKindState = {
  /** 「사용」 칸에 그릴 값. */
  enabled: boolean;
  /** 역할 코드 → 그 칸에 그릴 값. 열쇠는 받은 표(row.roles)와 똑같다. */
  roles: Record<string, boolean>;
  /** 🔴 역할 칸이 잠기는가. 잠긴 칸은 폼에 실리지 않는다(이 파일 머리말). */
  rolesLocked: boolean;
  /** 저장을 누르면 이 줄이 **실제로** 바뀌는가 — 잠겨서 안 실릴 칸은 빼고 센다. */
  differsFromStored: boolean;
};

/**
 * 화면이 그 줄에 그릴 값을 정한다.
 *
 * ── 🔴 「전부 기본값으로」가 여기 있다 ────────────────────────────────────
 * `showDefaults` 가 참이면 지금 저장된 값 대신 **그 시스템이 함께 보낸 기본값**
 * (defaultEnabled · defaultReceives)을 그린다. A/S 화면의 같은 이름 단추와 뜻이
 * 같다 — **화면만 기본값으로 돌리고, 저장을 눌러야 실제로 바뀐다.** 포털 화면은
 * 자바스크립트 없이 도는 서버 폼이라 A/S 처럼 useState 를 쓸 수 없고, 대신 주소에
 * 표시를 하나 달아(`?defaults=<clientId>`) 서버가 같은 표를 기본값으로 한 번 더
 * 그린다. 그러면 저장 쪽은 손댈 것이 없다 — 사람이 손으로 기본값과 똑같이 체크한
 * 것과 **글자 그대로 같은 폼**이 올라가기 때문이다.
 *
 * 🔴 기본값에서 사용이 꺼지는 종류가 있으면, 그 줄은 기본값 표에서도 잠긴다 =
 * 역할 칸이 실리지 않는다 = 그 줄의 역할은 **기본값으로 돌아가지 않는다**(사용만
 * 꺼진다). 잠긴 칸은 보내지 않는다는 한 가지 규칙을 지킨 결과다. A/S 는 브라우저
 * 쪽에서 값을 만들어 보내므로 그 줄의 역할까지 기본값으로 쓴다 — 지금 A/S 의
 * 종류는 전부 기본이 「켜짐」이라(domain/notification-settings.ts) 실제로 갈리는
 * 경우가 없지만, 갈리는 날이 오면 이 문단이 그 차이의 근거다.
 */
export function shownKindState(params: {
  row: PortalSettingsKind;
  roles: readonly PortalSettingsRole[];
  showDefaults: boolean;
}): ShownKindState {
  const { row, showDefaults } = params;

  const enabled = showDefaults ? row.defaultEnabled : row.enabled;
  // fromEntries 로 만드는 까닭: 역할 코드는 저쪽이 보낸 글자라 `__proto__` 도 올
  // 수 있고, 그때 `obj[code] = …` 는 칸을 만들지 못한 채 조용히 삼켜진다.
  const roles = Object.fromEntries(
    Object.entries(row.roles).map(([code, cell]) => [
      code,
      showDefaults ? cell.defaultReceives : cell.receives,
    ])
  );
  const rolesLocked = !enabled;

  let differsFromStored = enabled !== row.enabled;
  if (!rolesLocked) {
    for (const role of params.roles) {
      if (!role.editable) continue;
      if (!Object.hasOwn(row.roles, role.code)) continue;
      if (roles[role.code] !== row.roles[role.code].receives) differsFromStored = true;
    }
  }

  return { enabled, roles, rolesLocked, differsFromStored };
}
