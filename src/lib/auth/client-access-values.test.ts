import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  accessChoices,
  currentAccessValue,
  GRANTED_NO_ROLE,
  NO_ACCESS,
} from "./client-access-values";

/**
 * ============================================================================
 * 관리 화면에서 **권한을 뺄 수 있는가** — 시스템 종류와 무관하게
 * ============================================================================
 * 「PO 에는 권한 없음을 고를 수 없다」는 지적에서 시작했다. 코드를 보니 줄은
 * 있었지만, 그 줄이 **화면 안에** 조건과 섞여 있었다. 조건 하나를 잘못 건드리면
 * 회수하는 길이 화면에서 조용히 사라지고, 오류도 시험 실패도 나지 않는다 —
 * 관리자는 그때 "이 시스템은 권한을 뺄 수 없나 보다"라고 읽는다.
 *
 * 그래서 목록 만들기를 accessChoices로 빼고, 여기서 못 박는다.
 * ============================================================================
 */

/**
 * 개발 DB 실측(2026-09-22)의 다섯 시스템. clients.available_roles 그대로다.
 *
 * 역할 목록은 시스템의 것이라 앞으로도 제각각이다(clients.ts 주석). 그러니
 * "어느 목록이 와도 회수하는 길은 있다"를 목록별로 확인한다.
 */
const SYSTEMS: { clientId: string; requiresGrant: boolean; roles: string[] }[] = [
  {
    clientId: "rf-service-system",
    requiresGrant: true,
    roles: ["SUPER_ADMIN", "ADMIN", "AS_ENGINEER", "SALES", "INVENTORY_MANAGER"],
  },
  // 🔴 역할을 쓰지 않는 유일한 시스템. 지적이 나온 곳이다.
  { clientId: "dss-po", requiresGrant: true, roles: [] },
  { clientId: "dss-meters", requiresGrant: false, roles: ["ADMIN", "VIEWER"] },
  { clientId: "dss-leave", requiresGrant: false, roles: ["MEMBER", "LEAVE_ADMIN"] },
  { clientId: "dss-improvements", requiresGrant: false, roles: ["ADMIN", "MEMBER"] },
];

// ───── 「권한 없음」을 고를 수 있는가 ─────

test("🔴 다섯 시스템 모두에서 「권한 없음」을 고를 수 있다", () => {
  for (const system of SYSTEMS) {
    const values = accessChoices(system.roles).map((choice) => choice.value);
    assert.ok(
      values.includes(NO_ACCESS),
      `${system.clientId} 에서 권한을 뺄 수 없다`
    );
  }
});

test("🔴 권한 확인을 하는 시스템(rf-service-system · dss-po)에는 특히 있어야 한다", () => {
  // requiresGrant=false인 시스템은 부여 행을 지워도 접근이 그대로다. 회수가
  // 실제로 차단이 되는 곳은 이 둘이고, 그러니 여기서 고르개가 없으면
  // "막을 수단이 화면에 없다"가 된다.
  const gated = SYSTEMS.filter((system) => system.requiresGrant);
  assert.equal(gated.length, 2);
  for (const system of gated) {
    assert.equal(accessChoices(system.roles)[0].value, NO_ACCESS, system.clientId);
  }
});

test("🔴 역할을 쓰지 않는 시스템(PO)에도 두 갈래가 다 있다", () => {
  assert.deepEqual(accessChoices([]), [
    { value: NO_ACCESS, label: "권한 없음" },
    { value: GRANTED_NO_ROLE, label: "권한 있음" },
  ]);
});

test("🔴 「권한 없음」은 언제나 첫 줄이다 — 역할이 몇 개든", () => {
  for (const roles of [[], ["ADMIN"], SYSTEMS[0].roles, ["A", "B", "C", "D", "E", "F"]]) {
    assert.equal(accessChoices(roles)[0].label, "권한 없음");
  }
});

// ───── 되돌릴 수 있는가 ─────

test("🔴 뺀 권한을 다시 줄 수 있다 — 목록에 주는 값이 늘 하나 이상 있다", () => {
  for (const system of SYSTEMS) {
    const giving = accessChoices(system.roles).filter(
      (choice) => choice.value !== NO_ACCESS
    );
    assert.ok(
      giving.length > 0,
      `${system.clientId} 는 한 번 빼면 다시 줄 수 없다`
    );
  }
});

// ───── 값이 액션과 맞는가 ─────

test("역할을 쓰는 시스템은 「권한 있음」을 쓰지 않는다 — 역할이 곧 권한이다", () => {
  // setClientAccess가 이 조합을 거절한다("역할을 지정해야 합니다"). 화면이
  // 그런 줄을 그리면 고를 수는 있는데 눌러도 실패하는 줄이 된다.
  //
  // 예외가 하나 있고, 그것은 일부러 둔 것이다 — **이미 그 상태인 행**을 그릴
  // 때는 그 줄을 붙인다. 눌러도 실패하는 줄이, 누르면 권한이 사라지는 줄보다
  // 낫다(아래 「역할이 빈 부여 행」 칸).
  const values = accessChoices(["ADMIN", "VIEWER"]).map((choice) => choice.value);
  assert.ok(!values.includes(GRANTED_NO_ROLE));
});

test("역할은 등록된 순서 그대로 나온다", () => {
  const roles = SYSTEMS[0].roles;
  assert.deepEqual(
    accessChoices(roles)
      .map((choice) => choice.value)
      .slice(1),
    roles
  );
});

test("특수 값 둘은 역할 이름과 겹칠 수 없는 꼴이다", () => {
  // 어느 시스템이 실수로 "__none__"을 역할로 등록하면, 그 역할을 고르는 것이
  // 곧 회수가 된다. 밑줄 두 개로 시작하는 꼴을 값으로 쓰는 까닭이다.
  for (const special of [NO_ACCESS, GRANTED_NO_ROLE]) {
    assert.match(special, /^__.+__$/);
  }
  assert.notEqual(NO_ACCESS, GRANTED_NO_ROLE);
  for (const system of SYSTEMS) {
    assert.ok(!system.roles.includes(NO_ACCESS), system.clientId);
    assert.ok(!system.roles.includes(GRANTED_NO_ROLE), system.clientId);
  }
});

// ───── 🔴 역할이 빈 부여 행 ─────
//
// 역할을 쓰는 시스템에 role이 NULL인 부여 행이 있으면, 그 사람은 **실제로
// 들어갈 수 있다.** 그런데 화면은 그것을 「권한 없음」으로 보여줬다. 관리자가
// 아무것도 고르지 않고 「적용」만 눌러도 고르개에 담겨 있던 NO_ACCESS가 제출되어
// 멀쩡한 권한이 회수됐고, 바로 옆에는 주황색 「역할 없음」 딱지가 떠 있었다 —
// 한 화면이 서로 모순된 말을 하고 있었다.
//
// 지금 DB에는 그런 행이 없다(2026-09-22 확인). 만들어지는 길은 둘이다:
// 명령줄 부여(막았다)와, 역할을 쓰지 않던 시스템에 나중에 역할 목록을 등록하는
// 것(막을 수 없다 — 그래서 화면 쪽도 함께 고쳤다).

const ROLES = SYSTEMS[0].roles;

test("🔴 역할이 빈 부여 행은 「권한 없음」으로 보이지 않는다", () => {
  const value = currentAccessValue({ role: null });
  assert.notEqual(value, NO_ACCESS, "부여 행이 있는데 권한 없음으로 보인다");
  assert.equal(value, GRANTED_NO_ROLE);
});

test("부여 행이 없을 때만 「권한 없음」이다", () => {
  assert.equal(currentAccessValue(undefined), NO_ACCESS);
  assert.equal(currentAccessValue(null), NO_ACCESS);
  assert.equal(currentAccessValue({ role: "ADMIN" }), "ADMIN");
});

test("🔴 그 상태를 담은 줄이 고르개에 있다 — 없으면 브라우저가 첫 줄을 고른다", () => {
  // select의 defaultValue가 어느 option에도 없으면 브라우저는 조용히 첫 줄을
  // 고른다. 여기서 첫 줄은 「권한 없음」이다. 그것이 이 결함의 실제 경로였다.
  for (const system of SYSTEMS) {
    const current = currentAccessValue({ role: null });
    const values = accessChoices(system.roles, current).map((c) => c.value);
    assert.ok(
      values.includes(current),
      `${system.clientId} 에서 지금 상태를 담은 줄이 없다`
    );
  }
});

test("🔴 그 상태로 「적용」을 눌러도 권한이 빠지지 않는다", () => {
  // 회수는 setClientAccess가 value === NO_ACCESS 로 갈라진다. 고르개가 담고
  // 있는 값이 그것과 다르면 회수 갈래로 가지 않는다.
  const current = currentAccessValue({ role: null });
  assert.notEqual(current, NO_ACCESS);

  const submitted = accessChoices(ROLES, current).find((c) => c.value === current);
  assert.ok(submitted, "제출할 줄이 없다");
  assert.notEqual(submitted.value, NO_ACCESS);

  // 그 값은 역할을 쓰는 시스템에서 액션이 거절한다 — 아무 일도 일어나지 않고
  // 관리자는 "역할을 지정해야 합니다"를 읽는다. 그 가드가 회수 갈래보다 앞에
  // 있어야 한다.
  const source = readFileSync("src/lib/server/actions/admin-access.ts", "utf8");
  const guard = source.indexOf(
    "if (value === GRANTED_NO_ROLE && client.availableRoles.length > 0)"
  );
  const revoke = source.indexOf("// ───── 회수 ─────");
  assert.ok(guard > 0, "역할 없는 값을 거절하는 가드가 사라졌다");
  assert.ok(guard < revoke, "가드가 회수 갈래보다 뒤에 있다");
});

test("🔴 화면이 모순된 말을 하지 않는다 — 고르개와 딱지가 같은 낱말을 쓴다", () => {
  const label = accessChoices(ROLES, GRANTED_NO_ROLE).at(-1)?.label ?? "";
  assert.match(label, /역할 없음/);

  // 딱지 쪽 낱말. 화면 본문에서 그대로 확인한다.
  const source = readFileSync("src/app/admin/users/page.tsx", "utf8");
  assert.ok(source.includes(">역할 없음<"), "주황색 딱지의 낱말이 바뀌었다");
});

test("등록되지 않은 역할을 가진 행도 줄을 갖는다", () => {
  // client:register 에 --role 을 다시 주면 역할 목록이 통째로 갈린다
  // (register-client.ts 주석). 이미 부여된 역할이 목록에서 빠질 수 있다.
  const choices = accessChoices(["ADMIN", "VIEWER"], "AS_ENGINEER");
  const mine = choices.find((c) => c.value === "AS_ENGINEER");
  assert.ok(mine, "목록에 없는 역할이 화면에서 사라진다");
  assert.match(mine.label, /등록되지 않은 역할/);
  // 이 줄도 회수가 아니다.
  assert.notEqual(mine.value, NO_ACCESS);
});

test("🔴 어떤 값이 와도 고르개는 그 값을 담은 줄을 갖는다", () => {
  const currents = [NO_ACCESS, GRANTED_NO_ROLE, "ADMIN", "낯선역할", ...ROLES];
  for (const system of SYSTEMS) {
    for (const current of currents) {
      const values = accessChoices(system.roles, current).map((c) => c.value);
      assert.ok(
        values.includes(current),
        `${system.clientId} · ${current} 을 담은 줄이 없다`
      );
    }
  }
});

test("줄이 덧붙어도 「권한 없음」은 첫 줄이고 역할 차례는 그대로다", () => {
  const choices = accessChoices(ROLES, GRANTED_NO_ROLE);
  assert.equal(choices[0].value, NO_ACCESS);
  assert.deepEqual(choices.slice(1, 1 + ROLES.length).map((c) => c.value), ROLES);
  // 설명할 수 있는 상태에는 줄을 덧붙이지 않는다.
  assert.equal(accessChoices(ROLES, "ADMIN").length, ROLES.length + 1);
  assert.equal(accessChoices(ROLES, NO_ACCESS).length, ROLES.length + 1);
  assert.equal(accessChoices([], GRANTED_NO_ROLE).length, 2);
});

// ───── 부르는 자리 ─────

test("🔴 화면은 목록을 직접 만들지 않는다 — 조건이 섞이면 줄이 사라진다", () => {
  const source = readFileSync("src/app/admin/users/page.tsx", "utf8");

  assert.ok(
    source.includes("accessChoices(client.availableRoles, current)"),
    "화면이 accessChoices를 쓰지 않는다"
  );
  // usesRoles 조건 안에서 옵션을 그리던 꼴로 돌아가지 않았는지 본다.
  assert.ok(
    !source.includes("<option value={NO_ACCESS}>"),
    "화면이 다시 자기 손으로 옵션을 그리고 있다"
  );
  assert.ok(
    !source.includes("<option value={GRANTED_NO_ROLE}>"),
    "화면이 다시 자기 손으로 옵션을 그리고 있다"
  );
});

test("🔴 화면은 지금 값도 직접 셈하지 않는다 — 그 셈이 이 결함이었다", () => {
  const source = readFileSync("src/app/admin/users/page.tsx", "utf8");

  assert.ok(
    source.includes("currentAccessValue(grant)"),
    "화면이 지금 값을 다시 자기 손으로 셈하고 있다"
  );
  // 돌아가면 안 되는 꼴. 부여 행이 있는데도 「권한 없음」이 되던 그 식이다.
  assert.ok(
    !source.includes("grant.role ?? NO_ACCESS"),
    "역할이 비면 「권한 없음」이 되는 식이 돌아왔다"
  );
});

test("🔴 명령줄은 역할을 쓰는 시스템에 역할 없이 부여하지 않는다", () => {
  // 스크립트는 불러오면 main()이 돌아 버려 시험에서 부를 수 없다. 자리를
  // 읽어 확인한다(grant-revocation.test.ts의 명령줄 시험과 같은 방식).
  const source = readFileSync("scripts/grant-client-access.ts", "utf8");

  const guard = source.indexOf(
    "if (!roleArg && client.availableRoles.length > 0)"
  );
  const insert = source.indexOf(".insert(userClientGrants)");
  assert.ok(guard > 0, "역할 없는 부여를 막는 자리가 사라졌다");
  assert.ok(guard < insert, "막기 전에 이미 행을 넣고 있다");

  // 막는 것으로 끝나야 한다 — 경고만 찍고 넣던 예전 꼴로 돌아가지 않았는지.
  const body = source.slice(guard, insert);
  assert.ok(body.includes("process.exitCode = 1"), "막지 않고 그냥 넘어간다");
  assert.ok(body.includes("return;"), "막지 않고 그냥 넘어간다");
});

test("🔴 「권한 없음」을 고르면 세션 끊기를 거친다", () => {
  // 고르개만 있고 끊기가 빠지면 이번 작업의 뜻이 반만 남는다. 회수 갈래가
  // NO_ACCESS로 갈라지고, 그 안에서 세션을 끊는다는 것을 자리로 못 박는다.
  const source = readFileSync("src/lib/server/actions/admin-access.ts", "utf8");

  const branch = source.indexOf("if (value === NO_ACCESS)");
  const cut = source.indexOf("cutSessionsForRevokedGrant(");
  const roleChange = source.indexOf("// ───── 역할 변경 ─────");

  assert.ok(branch > 0, "「권한 없음」을 알아보는 갈래가 사라졌다");
  assert.ok(cut > branch && cut < roleChange, "「권한 없음」 갈래에서 세션을 끊지 않는다");
});
