import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSourceFeed } from "@/lib/notifications/merge";
import { parseApprovalInbox } from "./inbox";
import { parseScreenApprovalInbox, screenApprovalKey } from "./screen-inbox";

/**
 * ============================================================================
 * 화면용 읽기 — **일곱 칸이 다 들어오고, 셋이 붙는다**
 * ============================================================================
 * 이 파일이 지키는 것 둘:
 *
 *  ① 승인함이 그릴 수 있는 열 칸이 빠짐없이 올라간다. 🔴 `key`·`sourceId`·
 *     `sourceName` 중 하나라도 빠지면 승인함은 그 줄을 **버리고** 「N건을 그리지
 *     못했습니다」를 띄운다 — 조용히 0건이 되는 것보다는 낫지만, 결재는 안 보인다.
 *  ② 🔴 **메일 쪽 울타리가 그대로다.** `inbox.ts` 는 여전히 둘만 들여온다.
 *     이 조각이 저 파일을 넓히지 않았다는 증거이고, 넓히는 날 여기서 깨진다.
 * ============================================================================
 */

const SOURCE = { clientId: "rf-service-system", name: "A/S 관리" };

/** 세 시스템이 보내는 일곱 칸. 🔴 값은 전부 가짜다. */
const SEVEN = {
  id: "approval:REPAIR_INSPECTION:11111111-2222-4333-8444-555555555555",
  kind: "REPAIR_INSPECTION",
  kindLabel: "접수건 검수 결재",
  subject: "TEST-2026-0001",
  detail: "",
  requestedAt: "2026-10-21T04:05:06.000Z",
  href: "http://as.test:3000/repair-cases/11111111-2222-4333-8444-555555555555/approval",
};

// ───────────────────────────────────────────── 일곱 칸 + 포털이 붙이는 셋

test("🔴 일곱 칸이 그대로 올라가고 포털이 셋을 붙인다 — 열 칸이 승인함의 계약이다", () => {
  const parsed = parseScreenApprovalInbox({ items: [SEVEN], count: 1 }, SOURCE);

  assert.notEqual(parsed, null);
  assert.equal(parsed?.items.length, 1, "표본이 비면 아래 단언이 공짜로 통과한다");

  assert.deepEqual(parsed?.items[0], {
    key: `rf-service-system:${SEVEN.id}`,
    sourceId: "rf-service-system",
    sourceName: "A/S 관리",
    ...SEVEN,
  });

  // 🔴 칸 이름이 하나라도 달라지면 승인함이 그 줄을 버린다. 이름을 못 박는다.
  assert.deepEqual(Object.keys(parsed?.items[0] ?? {}).sort(), [
    "detail",
    "href",
    "id",
    "key",
    "kind",
    "kindLabel",
    "sourceId",
    "sourceName",
    "subject",
    "requestedAt",
  ].sort());
});

test("🔴 열쇠는 종이 쓰는 꼴과 **같다** — 같은 결재를 두 화면에서 맞춰 볼 수 있다", () => {
  const id = "approval:QUOTE_APPROVAL:q-1";

  const bell = parseSourceFeed(
    { items: [{ id, subject: "제목", href: "http://as.test/x" }], count: 1 },
    {
      clientId: "rf-service-system",
      name: "A/S 관리",
      notificationsUrl: "http://as.test/api/integration/notifications",
      settingsUrl: "http://as.test/api/integration/notification-settings",
    }
  );
  const screen = parseScreenApprovalInbox({ items: [{ ...SEVEN, id }] }, SOURCE);

  assert.equal(bell.items.length, 1, "종 쪽 표본이 비었다");
  assert.equal(screen?.items.length, 1, "화면 쪽 표본이 비었다");
  // 🔴 꼴이 갈라지면 두 화면의 같은 줄을 맞춰 볼 길이 없어진다.
  assert.equal(screen?.items[0].key, bell.items[0].key);
  assert.equal(screen?.items[0].key, screenApprovalKey("rf-service-system", id));
});

test("🔴 시스템 이름은 **포털이 가진 것**을 쓴다 — 저쪽이 적어 보낸 이름이 아니다", () => {
  const parsed = parseScreenApprovalInbox(
    { items: [{ ...SEVEN, sourceName: "남의 시스템", sourceId: "dss-leave", key: "가짜열쇠" }] },
    SOURCE
  );

  assert.equal(parsed?.items.length, 1);
  assert.equal(parsed?.items[0].sourceName, "A/S 관리");
  assert.equal(parsed?.items[0].sourceId, "rf-service-system");
  assert.equal(parsed?.items[0].key, `rf-service-system:${SEVEN.id}`);
});

// ───────────────────────────────────────────── 버리는 줄은 하나뿐이다

test("🔴 `id` 가 없는 줄만 버린다 — 열쇠를 지을 수 없기 때문이다", () => {
  const parsed = parseScreenApprovalInbox(
    {
      items: [
        SEVEN,
        { ...SEVEN, id: "" },
        { ...SEVEN, id: 7 },
        "줄이 아니다",
        null,
        { ...SEVEN, id: "둘째" },
      ],
    },
    SOURCE
  );

  assert.deepEqual(
    parsed?.items.map((item) => item.id),
    [SEVEN.id, "둘째"]
  );
  assert.equal(parsed?.dropped, 4);
});

test("🔴 나머지 여섯 칸은 **모양이 틀려도 버리지 않는다** — 승인함이 세어 화면에 말한다", () => {
  // 포털이 먼저 버리면 그 안내가 뜨지 않는다. 줄은 사라지고 「결재할 게 없네」로
  // 읽힌다 — 이 저장소에서 가장 나쁜 실패의 모양이다.
  const parsed = parseScreenApprovalInbox(
    { items: [{ id: "x", kind: 1, kindLabel: null, subject: {}, requestedAt: undefined }] },
    SOURCE
  );

  assert.equal(parsed?.items.length, 1);
  assert.equal(parsed?.dropped, 0);
  // 🔴 글자가 아닌 값은 빈 글자로 바뀐다 — 타입이 string 이라고 적어 놓고 아닌
  //    값을 흘려 보내지 않는다. 빈 칸은 승인함이 `unreadable` 로 센다.
  assert.deepEqual(parsed?.items[0], {
    key: "rf-service-system:x",
    sourceId: "rf-service-system",
    sourceName: "A/S 관리",
    id: "x",
    kind: "",
    kindLabel: "",
    subject: "",
    detail: "",
    requestedAt: "",
    href: "",
  });
});

test("`detail` 이 빈 글자인 것은 정상이다 — A/S 의 접수건 결재가 그렇게 온다", () => {
  const parsed = parseScreenApprovalInbox({ items: [{ ...SEVEN, detail: "" }] }, SOURCE);
  assert.equal(parsed?.items.length, 1);
  assert.equal(parsed?.items[0].detail, "");
});

// ───────────────────────────────────────────── 「없다」와 「못 읽겠다」

test("모양이 아예 다르면 null 이다 — 「결재가 없다」로 읽으면 안 된다", () => {
  assert.equal(parseScreenApprovalInbox(null, SOURCE), null);
  assert.equal(parseScreenApprovalInbox("ok", SOURCE), null);
  assert.equal(parseScreenApprovalInbox({ 결재: [] }, SOURCE), null);
  assert.equal(parseScreenApprovalInbox({ items: "셋" }, SOURCE), null);
});

test("빈 목록은 정상이다 — 결재할 것이 없는 사람이 대부분이다", () => {
  assert.deepEqual(parseScreenApprovalInbox({ items: [], count: 0 }, SOURCE), {
    items: [],
    dropped: 0,
  });
});

test("🔴 휴가의 계정 미연결은 **받은 글자 그대로** 올린다", () => {
  const parsed = parseScreenApprovalInbox(
    { items: [], count: 0, unavailable: "employee_not_linked" },
    { clientId: "dss-leave", name: "휴가 관리" }
  );
  assert.equal(parsed?.unavailable, "employee_not_linked");

  // 🔵 모르는 사정도 버리지 않는다 — 버리면 「0건」과 구별되지 않는다.
  const later = parseScreenApprovalInbox(
    { items: [], unavailable: "payroll_locked" },
    { clientId: "dss-leave", name: "휴가 관리" }
  );
  assert.equal(later?.unavailable, "payroll_locked");
});

// ───────────────────────────────────────────── 🔴 메일 쪽 울타리

test("🔴 메일 쪽 `inbox.ts` 는 여전히 **두 칸만** 들여온다 — 이 조각이 울타리를 안 건드렸다", () => {
  // 메일 본문에 결재 내용을 싣지 않기로 한 2026-10-23 결정의 구조적 증거다.
  // 본문을 만드는 자리에 그 값이 **존재하지 않으면** 실을 수가 없다.
  const mail = parseApprovalInbox({ items: [SEVEN], count: 1 });

  assert.equal(mail?.items.length, 1, "표본이 비면 아래 단언이 공짜로 통과한다");
  assert.deepEqual(mail?.items[0], { id: SEVEN.id, kind: SEVEN.kind });
  assert.deepEqual(Object.keys(mail?.items[0] ?? {}).sort(), ["id", "kind"]);

  // 🔴 제목 · 보탬 · 주소 · 갈래 이름 · 시각은 포털의 어느 변수에도 담기지 않는다.
  for (const field of ["kindLabel", "subject", "detail", "requestedAt", "href"]) {
    assert.equal(
      (mail?.items[0] as Record<string, unknown>)[field],
      undefined,
      `메일 쪽이 ${field} 를 들여왔다 — 울타리가 열렸다`
    );
  }
});
