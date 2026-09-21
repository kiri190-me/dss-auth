import assert from "node:assert/strict";
import { test } from "node:test";
import { messageFrom, parseSettingsChanges, parseSettingsPayload } from "./settings";

/** A/S 의 설정 통로가 실제로 내주는 모양(그쪽 PortalNotificationSettings). */
function payload(over: { roles?: unknown; kinds?: unknown } = {}) {
  return {
    roles: over.roles ?? [
      { code: "ADMIN", label: "관리자", editable: true },
      { code: "SUPER_ADMIN", label: "최고관리자", editable: false },
    ],
    kinds: over.kinds ?? [
      {
        kind: "REPAIR_CASE_APPROVAL",
        label: "접수건 결재 대기",
        description: "결재를 기다리는 접수 건이 있을 때",
        enabled: true,
        defaultEnabled: true,
        roles: {
          ADMIN: { receives: true, defaultReceives: true },
          SUPER_ADMIN: { receives: false, defaultReceives: true },
        },
      },
    ],
  };
}

test("그 시스템이 보낸 표를 그대로 받는다", () => {
  const parsed = parseSettingsPayload(payload());
  assert.ok(parsed);
  assert.deepEqual(parsed.roles, [
    { code: "ADMIN", label: "관리자", editable: true },
    { code: "SUPER_ADMIN", label: "최고관리자", editable: false },
  ]);
  assert.equal(parsed.kinds[0].kind, "REPAIR_CASE_APPROVAL");
  assert.deepEqual(parsed.kinds[0].roles.SUPER_ADMIN, {
    receives: false,
    defaultReceives: true,
  });
});

test("🔴 역할 이름을 그 시스템에게서 받는다 — 포털에 코드표를 두지 않는다", () => {
  // 포털이 번역표를 가지면 A/S 가 역할을 하나 늘릴 때마다 포털을 고쳐
  // 배포해야 한다(설계서 F-4).
  const parsed = parseSettingsPayload(
    payload({ roles: [{ code: "INVENTORY_MANAGER", label: "재고담당", editable: true }] })
  );
  assert.ok(parsed);
  assert.equal(parsed.roles[0].label, "재고담당");
});

test("잠긴 줄 표시를 그대로 나른다", () => {
  const parsed = parseSettingsPayload(payload());
  assert.ok(parsed);
  assert.equal(parsed.roles[1].editable, false);
});

test("설명이 없어도 표는 그린다", () => {
  const kinds = payload().kinds as Record<string, unknown>[];
  delete kinds[0].description;
  const parsed = parseSettingsPayload({ ...payload(), kinds });
  assert.ok(parsed);
  assert.equal(parsed.kinds[0].description, "");
});

test("모양이 깨지면 null — 반쪽짜리 표를 그리지 않는다", () => {
  // 안 보이는 줄이 「꺼짐」처럼 읽히고, 그 상태로 저장하면 보이지 않던 줄이
  // 그대로 남는다. 「지금은 볼 수 없다」가 정직하다.
  const broken: unknown[] = [
    null,
    undefined,
    "글자",
    {},
    { roles: [], kinds: null },
    { roles: [{ code: "ADMIN" }], kinds: [] },
    { roles: [{ code: "", label: "빈 코드", editable: true }], kinds: [] },
    payload({ kinds: [{ kind: "A", label: "가", enabled: true }] }),
    payload({ kinds: [{ kind: "A", label: "가", enabled: true, defaultEnabled: true, roles: [] }] }),
    payload({
      kinds: [
        {
          kind: "A",
          label: "가",
          enabled: true,
          defaultEnabled: true,
          roles: { ADMIN: { receives: "예" } },
        },
      ],
    }),
  ];
  for (const raw of broken) {
    assert.equal(parseSettingsPayload(raw), null, JSON.stringify(raw));
  }
});

// ─────────────────────────────────────────────────────────── 저장 요청

test("저장 요청의 모양만 본다", () => {
  const result = parseSettingsChanges({
    changes: [
      { kind: "REPAIR_CASE_APPROVAL", enabled: false, roles: { ADMIN: true, AS_ENGINEER: false } },
    ],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.changes[0].roles, { ADMIN: true, AS_ENGINEER: false });
});

test("🔴 값이 옳은지는 보지 않는다 — 모르는 종류·역할은 그 시스템이 거른다", () => {
  // 포털이 그 판정을 흉내 내면 곧 A/S 의 어휘가 포털에 스며든다.
  const result = parseSettingsChanges({
    changes: [{ kind: "이런_종류는_없다", enabled: true, roles: { 없는역할: true } }],
  });
  assert.ok(result.ok);
  assert.equal(result.changes[0].kind, "이런_종류는_없다");
});

test("바꿀 것이 없는 요청도 모양으로는 맞다", () => {
  const result = parseSettingsChanges({ changes: [] });
  assert.ok(result.ok);
  assert.deepEqual(result.changes, []);
});

test("모양이 아니면 까닭을 적어 거절한다", () => {
  for (const body of [
    null,
    "글자",
    {},
    { changes: "목록아님" },
    { changes: [null] },
    { changes: [{ enabled: true, roles: {} }] },
    { changes: [{ kind: "A", roles: {} }] },
    { changes: [{ kind: "A", enabled: true }] },
    { changes: [{ kind: "A", enabled: true, roles: [] }] },
    { changes: [{ kind: "A", enabled: true, roles: { ADMIN: "예" } }] },
  ]) {
    const result = parseSettingsChanges(body);
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.ok(result.ok === false && result.message.length > 0);
  }
});

test("저쪽이 적어 보낸 까닭을 그대로 쓰고, 없으면 우리가 적는다", () => {
  assert.equal(messageFrom({ message: "관리자만 가능합니다." }, "기본"), "관리자만 가능합니다.");
  assert.equal(messageFrom({ message: "" }, "기본"), "기본");
  assert.equal(messageFrom(null, "기본"), "기본");
  assert.equal(messageFrom("글자", "기본"), "기본");
});
