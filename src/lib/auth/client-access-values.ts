/**
 * 관리 화면의 시스템 접근 select가 주고받는 특수 값.
 *
 * 서버 액션 파일("use server")은 async 함수만 내보낼 수 있어 상수를 함께
 * 둘 수 없다. 화면과 액션이 같은 문자열을 봐야 하므로 여기로 뺀다.
 *
 * 빈 문자열을 쓰지 않는 이유: FormData는 빈 값과 없는 값을 같게 보내고,
 * select에서도 "권한 없음"과 구분되지 않는다.
 */
export const NO_ACCESS = "__none__";

/** 역할 개념이 없는 시스템에서 "들어갈 수는 있다"를 뜻한다. */
export const GRANTED_NO_ROLE = "__granted__";

/** select의 한 줄. value는 setClientAccess가 받는 값 그대로다. */
export type AccessChoice = { value: string; label: string };

/**
 * 지금 부여 상태를 고르개가 보여줄 값 하나로 바꾼다.
 *
 * 🔴 **역할이 비어 있어도 「권한 없음」이 되지 않는다.** 이 함수가 따로 있는
 * 까닭이 그것이다. 부여 행이 있으면 그 사람은 실제로 들어갈 수 있는데, 전에는
 * 역할을 쓰는 시스템에서 role이 NULL이면 화면이 NO_ACCESS를 보여줬다. 그러면
 * 관리자가 본 것("권한 없음")과 DB의 사실("권한 있음")이 어긋나고, 그 상태에서
 * 「적용」을 누르는 순간 고르개가 담고 있던 NO_ACCESS가 그대로 제출되어
 * **멀쩡한 권한이 회수된다.** 관리자는 아무것도 고르지 않았는데도 그렇게 된다.
 *
 * 부여 행이 없을 때만 NO_ACCESS다. 있으면 역할이 곧 값이고, 역할이 비어 있으면
 * GRANTED_NO_ROLE("들어갈 수는 있다")이다 — 역할을 쓰지 않는 시스템과 같은 값을
 * 쓴다. 뜻이 똑같고, setClientAccess가 이미 그 값을 역할 쓰는 시스템에서
 * 거절하므로(아래 accessChoices 주석) 판정을 새로 만들지 않아도 된다.
 */
export function currentAccessValue(
  grant: { role: string | null } | null | undefined
): string {
  if (!grant) return NO_ACCESS;
  return grant.role ?? GRANTED_NO_ROLE;
}

/**
 * 시스템 하나의 고르개에 들어갈 줄 전부.
 *
 * 🔴 **「권한 없음」이 언제나 첫 줄이다.** 이것이 이 함수가 따로 있는 이유다 —
 * 회수는 급할 때 하는 일인데, 역할 목록을 그리는 곳에 섞여 있으면 조건을 하나
 * 잘못 건드리는 순간 "빼는 길"이 화면에서 사라진다. 그것은 오류 없이 화면에서만
 * 드러나고, 관리자는 그때 "이 시스템은 권한을 뺄 수 없나 보다"라고 읽는다.
 * 그래서 화면이 아니라 여기에 두고 시험으로 못 박는다.
 *
 * 역할을 쓰지 않는 시스템(clients.available_roles가 빈 배열 — 지금은 dss-po)은
 * "권한 있음/없음" 두 줄이 되고, 역할을 쓰는 시스템은 「권한 없음」 + 역할들이
 * 된다. 두 경우 모두 첫 줄은 같다.
 *
 * ⚠️ 여기서 고른 역할이 받는 시스템의 권한을 그대로 정한다. 목록은 그 시스템이
 * 등록한 것만 쓴다(clients.available_roles) — 포털이 역할 이름을 만들어 내면
 * 받는 쪽이 모르는 값이 된다.
 *
 * ── 🔴 current: 지금 상태를 담은 줄이 **언제나** 있어야 한다 ─────────────────
 * select의 defaultValue가 어느 option에도 없으면 브라우저는 조용히 **첫 줄**을
 * 고른다. 그 첫 줄이 여기서는 「권한 없음」이라, 설명할 수 없는 상태는 곧
 * "권한 없음으로 보이고, 적용하면 권한이 빠지는" 상태가 된다. 오류도 시험
 * 실패도 없이 화면에서만 드러나는 종류다.
 *
 * 그런 상태가 둘 있다(둘 다 지금 DB에는 없지만 만들어지는 길이 있다):
 *   1. 역할을 쓰는 시스템의 **역할이 빈 부여 행** — GRANTED_NO_ROLE.
 *      명령줄로는 막았고(scripts/grant-client-access.ts), 역할을 쓰지 않던
 *      시스템에 나중에 역할 목록을 등록하면 기존 행들이 전부 이 꼴이 된다.
 *   2. 목록에 **없는 역할**을 가진 부여 행 — client:register가 --role을 다시
 *      주면 역할 목록을 통째로 갈아 치우기 때문이다(register-client.ts 주석).
 *
 * 그 줄을 눌러 제출하면 setClientAccess가 거절한다("역할을 지정해야 합니다" ·
 * "…의 역할이 아닙니다"). 🔴 그것이 노린 결과다 — 눌러도 아무 일이 없는 줄이,
 * 누르면 권한이 사라지는 줄보다 낫다. 관리자는 그 문구를 보고 역할을 고른다.
 */
export function accessChoices(
  availableRoles: string[],
  current?: string
): AccessChoice[] {
  const choices: AccessChoice[] = [
    { value: NO_ACCESS, label: "권한 없음" },
    ...(availableRoles.length > 0
      ? availableRoles.map((role) => ({ value: role, label: role }))
      : [{ value: GRANTED_NO_ROLE, label: "권한 있음" }]),
  ];

  // 맨 뒤에 붙인다. 「권한 없음」이 첫 줄이라는 것과 역할이 등록된 차례대로
  // 나온다는 것을 둘 다 건드리지 않는다.
  if (current !== undefined && !choices.some((choice) => choice.value === current)) {
    choices.push({
      value: current,
      label:
        current === GRANTED_NO_ROLE
          ? // 화면의 주황색 딱지와 **같은 낱말**을 쓴다. 고르개는 "권한 없음",
            // 딱지는 "역할 없음"이던 것이 이 결함의 눈에 보이는 얼굴이었다.
            "⚠ 역할 없음"
          : `⚠ ${current} (등록되지 않은 역할)`,
    });
  }

  return choices;
}
