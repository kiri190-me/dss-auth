import assert from "node:assert/strict";
import { test } from "node:test";
import type { PortalSettingsKind, PortalSettingsRole } from "./settings";
import {
  KIND_MARKER_FIELD,
  diffSubmittedSettings,
  enabledFieldName,
  receivesFieldName,
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
