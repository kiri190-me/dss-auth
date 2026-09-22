import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PortalSettingsKind, PortalSettingsRole } from "./settings";
import {
  KIND_MARKER_FIELD,
  ROLES_LOCKED_FIELD,
  diffSubmittedSettings,
  enabledFieldName,
  receivesFieldName,
  shownKindState,
} from "./settings-form";

/**
 * A/S 가 실제로 내주는 모양을 줄여 쓴 것. 🔴 역할 이름은 **받은 것**이지 포털이
 * 아는 것이 아니다 — 시험에서도 그 자리를 그대로 지킨다.
 */
const ROLES: PortalSettingsRole[] = [
  { code: "STAFF", label: "직원", editable: true },
  { code: "ADMIN", label: "관리자", editable: true },
  { code: "SUPER_ADMIN", label: "최고관리자", editable: false },
];

function kind(over: Partial<PortalSettingsKind> = {}): PortalSettingsKind {
  return {
    kind: "REPAIR_CASE_APPROVAL",
    label: "접수건 결재 대기",
    description: "결재를 기다리는 접수 건이 있을 때",
    enabled: true,
    defaultEnabled: true,
    roles: {
      STAFF: { receives: false, defaultReceives: false },
      ADMIN: { receives: true, defaultReceives: true },
      SUPER_ADMIN: { receives: true, defaultReceives: true },
    },
    ...over,
  };
}

/** 화면이 보내는 그대로 — 체크된 칸만 실린다. */
function form(params: {
  onScreen: string[];
  enabled?: string[];
  receiving?: [string, string][];
}): FormData {
  const data = new FormData();
  for (const value of params.onScreen) data.append(KIND_MARKER_FIELD, value);
  for (const value of params.enabled ?? []) data.append(enabledFieldName(value), "on");
  for (const [k, role] of params.receiving ?? []) {
    data.append(receivesFieldName(k, role), "on");
  }
  return data;
}

test("아무것도 건드리지 않았으면 보낼 것이 없다", () => {
  const kinds = [kind()];
  const changes = diffSubmittedSettings({
    form: form({
      onScreen: ["REPAIR_CASE_APPROVAL"],
      enabled: ["REPAIR_CASE_APPROVAL"],
      receiving: [["REPAIR_CASE_APPROVAL", "ADMIN"]],
    }),
    roles: ROLES,
    kinds,
  });
  assert.deepEqual(changes, []);
});

test("바뀐 종류만 싣는다", () => {
  const kinds = [
    kind(),
    kind({ kind: "PART_LOW_STOCK", label: "재고 부족", enabled: false, defaultEnabled: false }),
  ];

  // 둘째 종류의 사용만 켰다.
  const changes = diffSubmittedSettings({
    form: form({
      onScreen: ["REPAIR_CASE_APPROVAL", "PART_LOW_STOCK"],
      enabled: ["REPAIR_CASE_APPROVAL", "PART_LOW_STOCK"],
      receiving: [
        ["REPAIR_CASE_APPROVAL", "ADMIN"],
        ["PART_LOW_STOCK", "ADMIN"],
      ],
    }),
    roles: ROLES,
    kinds,
  });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "PART_LOW_STOCK");
  assert.equal(changes[0].enabled, true);
});

test("🔴 잠긴 역할은 아예 싣지 않는다 — 거짓이 실리면 저쪽이 저장을 통째로 거절한다", () => {
  // disabled 칸은 브라우저가 보내지 않으므로 늘 「체크 없음」으로 읽힌다.
  // 그것을 그대로 담으면 A/S 의 saveNotificationSettings 가 FORBIDDEN 을 내고,
  // 함께 바꾼 다른 줄까지 하나도 저장되지 않는다.
  const changes = diffSubmittedSettings({
    form: form({
      onScreen: ["REPAIR_CASE_APPROVAL"],
      // 사용을 껐다 = 바뀐 줄
      receiving: [["REPAIR_CASE_APPROVAL", "ADMIN"]],
    }),
    roles: ROLES,
    kinds: [kind()],
  });

  assert.equal(changes.length, 1);
  assert.equal(Object.hasOwn(changes[0].roles, "SUPER_ADMIN"), false);
  assert.deepEqual(changes[0].roles, { STAFF: false, ADMIN: true });
});

test("바뀐 종류에는 안 바뀐 역할 칸도 함께 싣는다 — PUT 은 그 종류의 상태를 맞추는 것이다", () => {
  const changes = diffSubmittedSettings({
    form: form({
      onScreen: ["REPAIR_CASE_APPROVAL"],
      enabled: ["REPAIR_CASE_APPROVAL"],
      // STAFF 를 새로 켰다. ADMIN 은 그대로 켜진 채다.
      receiving: [
        ["REPAIR_CASE_APPROVAL", "STAFF"],
        ["REPAIR_CASE_APPROVAL", "ADMIN"],
      ],
    }),
    roles: ROLES,
    kinds: [kind()],
  });

  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].roles, { STAFF: true, ADMIN: true });
});

test("체크가 빠진 칸은 꺼짐으로 읽는다", () => {
  const changes = diffSubmittedSettings({
    form: form({
      onScreen: ["REPAIR_CASE_APPROVAL"],
      enabled: ["REPAIR_CASE_APPROVAL"],
      // ADMIN 체크를 풀었다.
      receiving: [],
    }),
    roles: ROLES,
    kinds: [kind()],
  });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].enabled, true);
  assert.equal(changes[0].roles.ADMIN, false);
});

test("🔴 화면에 없던 종류는 건드리지 않는다 — 화면을 연 뒤 저쪽이 늘린 줄", () => {
  // 표시가 실려 오지 않은 종류는 사람이 뜻을 정한 적이 없다. 체크가 없다고
  // 「전부 끄라」로 읽으면 열어만 두고 저장한 사람이 새 알림을 꺼 버린다.
  const changes = diffSubmittedSettings({
    form: form({
      onScreen: ["REPAIR_CASE_APPROVAL"],
      enabled: ["REPAIR_CASE_APPROVAL"],
      receiving: [["REPAIR_CASE_APPROVAL", "ADMIN"]],
    }),
    roles: ROLES,
    kinds: [kind(), kind({ kind: "NEWLY_ADDED", label: "새로 생긴 알림" })],
  });

  assert.deepEqual(changes, []);
});

test("표에 없는 역할 칸은 만들어 내지 않는다", () => {
  // 종류마다 역할 칸이 다 차 있으리라고 믿지 않는다. 없는 칸을 거짓으로
  // 채우면 저쪽에서 「끈 것」이 된다.
  const changes = diffSubmittedSettings({
    form: form({ onScreen: ["REPAIR_CASE_APPROVAL"] }),
    roles: ROLES,
    kinds: [
      kind({
        enabled: true,
        roles: { ADMIN: { receives: true, defaultReceives: true } },
      }),
    ],
  });

  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].roles, { ADMIN: false });
});

test("Object 가 가진 이름과 같은 역할 코드를 칸으로 착각하지 않는다", () => {
  // 역할 코드는 저쪽이 보낸 글자다. 대괄호 조회만 하면 `toString` 이 늘 「있는
  // 칸」이 되고, 없는 칸에 값을 만들어 보내게 된다.
  const changes = diffSubmittedSettings({
    form: form({ onScreen: ["X"], enabled: ["X"] }),
    roles: [{ code: "toString", label: "이상한 역할", editable: true }],
    kinds: [kind({ kind: "X", enabled: false, roles: {} })],
  });

  assert.deepEqual(changes, [{ kind: "X", enabled: true, roles: {} }]);
});

test("역할 칸이 하나도 없는 종류도 스위치만으로 바뀐다", () => {
  const changes = diffSubmittedSettings({
    form: form({ onScreen: ["QUIET"], enabled: ["QUIET"] }),
    roles: ROLES,
    kinds: [kind({ kind: "QUIET", enabled: false, roles: {} })],
  });

  assert.deepEqual(changes, [{ kind: "QUIET", enabled: true, roles: {} }]);
});

// ───────────────────── 사용을 끈 줄의 역할 칸은 잠긴다 (화면 ↔ 폼 ↔ 저장)

/** 저장된 값이 기본값과 어긋나 있는 줄 하나. 기본값으로 되돌릴 거리가 있다. */
function deviated(over: Partial<PortalSettingsKind> = {}): PortalSettingsKind {
  return kind({
    roles: {
      // 기본에는 없던 대상을 넣어 뒀다(▲).
      STAFF: { receives: true, defaultReceives: false },
      // 기본에 있던 대상을 뺐다(▼).
      ADMIN: { receives: false, defaultReceives: true },
      SUPER_ADMIN: { receives: true, defaultReceives: true },
    },
    ...over,
  });
}

/**
 * 🔴 브라우저가 이 표를 어떻게 보내는지 그대로 흉내 낸다 — 체크된 칸만 싣고,
 * **disabled 칸은 아예 싣지 않는다.** 화면(page.tsx)과 이 파일 사이의 약속이
 * 여기에 있다. 화면이 잠그는 조건을 바꾸면 이 함수가 따라 바뀌어야 하고, 그때
 * 아래 시험들이 저장 결과가 달라지는지를 곧바로 보여 준다.
 */
function submit(params: {
  kinds: readonly PortalSettingsKind[];
  roles: readonly PortalSettingsRole[];
  showDefaults: boolean;
}): FormData {
  const data = new FormData();
  for (const row of params.kinds) {
    const shown = shownKindState({
      row,
      roles: params.roles,
      showDefaults: params.showDefaults,
    });
    data.append(KIND_MARKER_FIELD, row.kind);
    if (shown.enabled) data.append(enabledFieldName(row.kind), "on");
    if (shown.rolesLocked) data.append(ROLES_LOCKED_FIELD, row.kind);

    for (const role of params.roles) {
      // 그 줄에 없는 칸은 체크박스 자체가 그려지지 않는다.
      if (!Object.hasOwn(row.roles, role.code)) continue;
      // 잠긴 칸(disabled)은 브라우저가 보내지 않는다.
      if (!role.editable || shown.rolesLocked) continue;
      if (shown.roles[role.code]) {
        data.append(receivesFieldName(row.kind, role.code), "on");
      }
    }
  }
  return data;
}

test("🔴 사용을 끈 종류는 역할 칸이 잠긴다", () => {
  const off = shownKindState({ row: deviated({ enabled: false }), roles: ROLES, showDefaults: false });
  assert.equal(off.enabled, false);
  assert.equal(off.rolesLocked, true);

  const on = shownKindState({ row: deviated(), roles: ROLES, showDefaults: false });
  assert.equal(on.rolesLocked, false);
});

test("🔴 잠긴 칸은 저장 결과를 바꾸지 않는다 — 꺼진 줄을 그대로 저장해도 보낼 것이 없다", () => {
  // 역할 칸이 잠겨 하나도 실려 오지 않는데, 그것을 「전부 껐다」로 읽으면 사용을
  // 껐다는 이유만으로 역할 설정이 통째로 지워진다.
  const kinds = [deviated({ enabled: false })];
  const changes = diffSubmittedSettings({
    form: submit({ kinds, roles: ROLES, showDefaults: false }),
    roles: ROLES,
    kinds,
  });
  assert.deepEqual(changes, []);
});

test("🔴 사용을 다시 켜도 잠겨 있던 역할은 건드리지 않는다 — 켜는 순간 돌아온다", () => {
  const kinds = [deviated({ enabled: false })];
  const form = submit({ kinds, roles: ROLES, showDefaults: false });
  // 사람이 「사용」만 켰다. 역할 칸은 잠긴 채 그려져 있어 여전히 실리지 않는다.
  form.append(enabledFieldName("REPAIR_CASE_APPROVAL"), "on");

  const changes = diffSubmittedSettings({ form, roles: ROLES, kinds });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].enabled, true);
  // 빈 채로 보내는 것이 곧 「그대로 두라」다(A/S: 빠진 역할은 건드리지 않는다).
  assert.deepEqual(changes[0].roles, {});
});

test("🔴 잠금 표시를 빠뜨리면 역할이 통째로 꺼진다 — 표시가 있는 까닭", () => {
  // 같은 폼에서 표시만 뺐다. 이 줄이 실패하기 시작하면 잠금과 안 실림의 관계가
  // 끊어진 것이다.
  const kinds = [deviated({ enabled: false })];
  const form = submit({ kinds, roles: ROLES, showDefaults: false });
  const without = new FormData();
  for (const [name, value] of form.entries()) {
    if (name === ROLES_LOCKED_FIELD) continue;
    without.append(name, value);
  }

  const changes = diffSubmittedSettings({ form: without, roles: ROLES, kinds });
  assert.deepEqual(changes, [
    { kind: "REPAIR_CASE_APPROVAL", enabled: false, roles: { STAFF: false, ADMIN: false } },
  ]);
});

// ───────────────────────────────────────────── 「전부 기본값으로」

test("「전부 기본값으로」는 그 시스템이 보낸 기본값을 그린다", () => {
  const shown = shownKindState({ row: deviated(), roles: ROLES, showDefaults: true });
  assert.equal(shown.enabled, true);
  assert.deepEqual(shown.roles, { STAFF: false, ADMIN: true, SUPER_ADMIN: true });
  assert.equal(shown.differsFromStored, true);
});

test("🔴 「전부 기본값으로」 표를 저장하면 기본값이 실제로 실린다", () => {
  const kinds = [deviated({ enabled: false, defaultEnabled: true })];
  const changes = diffSubmittedSettings({
    form: submit({ kinds, roles: ROLES, showDefaults: true }),
    roles: ROLES,
    kinds,
  });

  assert.deepEqual(changes, [
    {
      kind: "REPAIR_CASE_APPROVAL",
      // defaultEnabled
      enabled: true,
      // defaultReceives. 잠긴 역할(SUPER_ADMIN)은 여전히 실리지 않는다.
      roles: { STAFF: false, ADMIN: true },
    },
  ]);
});

test("이미 기본값 그대로인 표에서는 「전부 기본값으로」가 아무것도 바꾸지 않는다", () => {
  const kinds = [kind()];
  const shown = shownKindState({ row: kinds[0], roles: ROLES, showDefaults: true });
  assert.equal(shown.differsFromStored, false);

  const changes = diffSubmittedSettings({
    form: submit({ kinds, roles: ROLES, showDefaults: true }),
    roles: ROLES,
    kinds,
  });
  assert.deepEqual(changes, []);
});

test("바뀔 줄 세기는 **실제로 실릴 것**만 센다 — 잠긴 줄의 역할은 빼고 본다", () => {
  // 기본값에서도 꺼지는 종류. 기본값 표에서도 그 줄은 잠기므로 역할은 그대로
  // 남는다 — 화면이 「바뀐다」고 색칠하면 거짓말이 된다.
  const row = deviated({ enabled: false, defaultEnabled: false });
  const shown = shownKindState({ row, roles: ROLES, showDefaults: true });

  assert.equal(shown.rolesLocked, true);
  assert.equal(shown.differsFromStored, false);
  assert.deepEqual(
    diffSubmittedSettings({
      form: submit({ kinds: [row], roles: ROLES, showDefaults: true }),
      roles: ROLES,
      kinds: [row],
    }),
    []
  );
});

// ───────────────────────────────── 이 표를 여는 길과 저장하는 길의 인가

test("🔴 저장 액션의 인가는 그대로다 — 포털 관리자만 저장한다", () => {
  const source = readFileSync("src/lib/server/actions/notification-settings.ts", "utf8");

  assert.ok(
    source.includes("const admin = await assertPortalAdmin();"),
    "저장 액션이 포털 관리자 확인을 하지 않는다"
  );
  // 화면을 거치지 않고 직접 불릴 수 있는 자리다. 확인이 저쪽에 물어보는 것보다
  // 뒤로 밀리면, 권한 없는 사람의 요청으로 그 시스템을 두드리게 된다.
  assert.ok(
    source.indexOf("assertPortalAdmin()") < source.indexOf("getNotificationSettings("),
    "권한 확인이 조회보다 뒤로 밀렸다"
  );
});

test("🔴 이 화면은 자바스크립트 없이 돈다 — 관리자 확인도 서버에서 한다", () => {
  const source = readFileSync("src/app/admin/notifications/page.tsx", "utf8");

  assert.ok(source.includes("await requirePortalAdmin()"), "화면 가드가 사라졌다");
  // 지시문이 한 줄이라도 들어오면 이 화면은 브라우저 조각이 된다. 주석 안에서
  // 그 말을 하는 것은 괜찮으므로(머리말이 그 까닭을 적어 두었다) **줄 전체가
  // 지시문인 경우**만 본다.
  const directive = /^\s*["']use client["'];?\s*$/;
  assert.ok(
    !source.split(/\r?\n/).some((line) => directive.test(line)),
    "화면이 브라우저 조각이 됐다"
  );
});

test("역할 목록이 통째로 달라져도 받은 것을 그대로 쓴다", () => {
  // 포털에 역할 코드표가 없다는 것을 시험으로 못 박는다(설계서 F-4).
  const changes = diffSubmittedSettings({
    form: form({ onScreen: ["X"], enabled: ["X"], receiving: [["X", "몰라도된다"]] }),
    roles: [{ code: "몰라도된다", label: "무엇이든", editable: true }],
    kinds: [
      kind({
        kind: "X",
        enabled: true,
        roles: { 몰라도된다: { receives: false, defaultReceives: false } },
      }),
    ],
  });

  assert.deepEqual(changes, [{ kind: "X", enabled: true, roles: { 몰라도된다: true } }]);
});
