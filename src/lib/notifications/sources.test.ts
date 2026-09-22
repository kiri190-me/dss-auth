import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientTile } from "@/lib/db/queries/clients";
import { NOTIFICATION_SOURCE_PATHS, toNotificationSources } from "./sources";

/**
 * listAccessibleClients 가 돌려주는 한 줄. 타입을 ClientTile 로 못 박아 둔다 —
 * 저쪽 조회가 칸을 바꾸면 이 시험이 먼저 깨진다(service-menu.test.ts 와 같은 이유).
 */
function tile(over: Partial<ClientTile> = {}): ClientTile {
  return {
    clientId: "rf-service-system",
    name: "DSS A/S 관리 시스템",
    description: "수리 접수부터 출고까지",
    // 런처 주소에는 경로가 붙어 있다 — 실제 등록값이 그렇다
    // (scripts/register-client.ts 의 사용법: '.../dashboard').
    launcherUrl: "http://192.168.0.12:3000/dashboard",
    launcherIcon: "🔧",
    ...over,
  };
}

test("알림 통로를 가진 시스템에만 묻는다", () => {
  // 계측기·개선요청·PO 에는 알림이 없다. 물어 봐야 404 가 오고, 그 404 는
  // 「죽었다」와 구별되지 않아 종이 이유 없이 빨개진다.
  const { sources } = toNotificationSources([
    tile(),
    tile({ clientId: "dss-meters", name: "계측기 관리" }),
    tile({ clientId: "dss-home", name: "회사 홈페이지" }),
  ]);
  assert.deepEqual(
    sources.map((source) => source.clientId),
    ["rf-service-system"]
  );
});

test("🔴 휴가 관리(dss-leave)에도 묻는다 — 통로를 연 둘째 시스템이다", () => {
  // 2026-09-22. 열쇠는 clients.client_id 이고, 그 값이 곧 토큰의 aud 가 된다 —
  // 한 글자라도 다르면 휴가 쪽이 401 로 거절하고 증상은 「휴가 결재 알림이
  // 안 온다」 하나뿐이다.
  const { sources } = toNotificationSources([
    tile({
      clientId: "dss-leave",
      name: "DSS 휴가 관리",
      launcherUrl: "http://192.168.0.12:3700/",
    }),
  ]);
  assert.deepEqual(
    sources.map((source) => source.clientId),
    ["dss-leave"]
  );
  assert.equal(
    sources[0].notificationsUrl,
    "http://192.168.0.12:3700/api/integration/notifications"
  );
  assert.equal(
    sources[0].settingsUrl,
    "http://192.168.0.12:3700/api/integration/notification-settings"
  );
});

test("두 시스템이 다 오면 둘 다 묻는다 — 한쪽이 다른 쪽을 가리지 않는다", () => {
  const { sources, skipped } = toNotificationSources([
    tile(),
    tile({ clientId: "dss-leave", name: "DSS 휴가 관리", launcherUrl: "http://192.168.0.12:3700/" }),
  ]);
  assert.deepEqual(
    sources.map((source) => source.clientId),
    ["rf-service-system", "dss-leave"]
  );
  assert.deepEqual(skipped, []);
});

test("🔴 접근 권한이 없어 목록에서 빠진 시스템에는 묻지 않는다", () => {
  // 판정은 listAccessibleClients 하나뿐이다. 이 함수는 clients 표를 보지
  // 않으므로 받지 않은 시스템을 만들어 낼 방법 자체가 없다.
  const { sources } = toNotificationSources([
    tile({ clientId: "dss-meters", name: "계측기 관리" }),
  ]);
  assert.deepEqual(sources, []);
});

test("쓸 수 있는 시스템이 하나도 없는 사람에게는 빈 목록 — 터지지 않는다", () => {
  assert.deepEqual(toNotificationSources([]), { sources: [], skipped: [] });
});

test("주소는 런처 주소의 origin 에서 온다 — 경로는 떼고 통로 경로를 붙인다", () => {
  const { sources } = toNotificationSources([tile()]);
  assert.equal(
    sources[0].notificationsUrl,
    "http://192.168.0.12:3000/api/integration/notifications"
  );
  assert.equal(
    sources[0].settingsUrl,
    "http://192.168.0.12:3000/api/integration/notification-settings"
  );
});

test("주소를 코드에 적지 않는다 — 상수에는 경로만 있다", () => {
  // docs/주소.md 가 없애려던 모양(「IP 가 바뀌면 고칠 곳이 시스템 수만큼」)으로
  // 돌아가지 않도록 못 박는다. 호스트·포트는 DB(clients.launcher_url)에서 온다.
  const json = JSON.stringify(NOTIFICATION_SOURCE_PATHS);
  assert.ok(!json.includes("http"), json);
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(json), json);
});

test("{lan} 이 펼쳐진 뒤의 주소를 그대로 따른다", () => {
  // listAccessibleClients 가 이미 펼쳐 준다. 기계가 바뀌면 이 값도 따라 바뀐다.
  const { sources } = toNotificationSources([
    tile({ launcherUrl: "http://10.150.71.135:3000/dashboard" }),
  ]);
  assert.equal(
    sources[0].notificationsUrl,
    "http://10.150.71.135:3000/api/integration/notifications"
  );
});

test("이름을 함께 나른다 — 종이 「어느 시스템의 알림인가」를 적어야 한다", () => {
  const { sources } = toNotificationSources([tile({ name: "우리 A/S" })]);
  assert.equal(sources[0].name, "우리 A/S");
  assert.equal(sources[0].clientId, "rf-service-system");
});

test("런처 주소가 없으면 묻지 않되, 까닭을 남긴다", () => {
  // 조용히 빠지면 증상이 「알림이 안 온다」 하나뿐이라 원인을 가리키지 않는다.
  const { sources, skipped } = toNotificationSources([tile({ launcherUrl: null })]);
  assert.deepEqual(sources, []);
  assert.deepEqual(skipped, [{ clientId: "rf-service-system", reason: "no_launcher_url" }]);
});

test("런처 주소가 주소가 아니면 묻지 않되, 까닭을 남긴다", () => {
  const { sources, skipped } = toNotificationSources([tile({ launcherUrl: "주소아님" })]);
  assert.deepEqual(sources, []);
  assert.deepEqual(skipped, [{ clientId: "rf-service-system", reason: "bad_launcher_url" }]);
});

test("알림이 없는 시스템은 skipped 에도 적지 않는다 — 빠지는 것이 정상이다", () => {
  const { skipped } = toNotificationSources([
    tile({ clientId: "dss-meters", launcherUrl: null }),
  ]);
  assert.deepEqual(skipped, []);
});

test("받은 차례를 지킨다 — sort_order 가 곧 종에 보일 차례다", () => {
  // 알림이 없는 시스템은 사이에 끼어 있어도 차례를 흔들지 않는다.
  const two = toNotificationSources([
    tile({ clientId: "dss-leave", name: "DSS 휴가 관리" }),
    tile({ clientId: "dss-meters" }),
    tile(),
  ]);
  assert.deepEqual(
    two.sources.map((source) => source.clientId),
    ["dss-leave", "rf-service-system"]
  );
});

test("받은 배열을 건드리지 않는다", () => {
  const tiles = [tile()];
  const before = JSON.stringify(tiles);
  toNotificationSources(tiles);
  assert.equal(JSON.stringify(tiles), before);
});
