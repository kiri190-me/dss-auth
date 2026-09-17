import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientTile } from "@/lib/db/queries/clients";
import {
  SERVICE_MENU_CLAIM,
  toServiceMenu,
  type ServiceMenuEntry,
} from "./service-menu";

/**
 * listAccessibleClients가 돌려주는 한 줄. 타입을 ClientTile로 못 박아 둔다 —
 * 저쪽 조회가 칸을 바꾸면 이 시험이 먼저 깨진다.
 */
function tile(over: Partial<ClientTile> = {}): ClientTile {
  return {
    clientId: "rf-service-system",
    name: "DSS A/S 관리 시스템",
    description: "수리 접수부터 출고까지",
    launcherUrl: "http://192.168.0.12:3000",
    launcherIcon: "🔧",
    ...over,
  };
}

/** 권한대로 걸러진 뒤의 목록. 세 시스템을 쓴다. */
const ACCESSIBLE: ClientTile[] = [
  tile(),
  tile({
    clientId: "dss-meters",
    name: "계측기 관리",
    launcherUrl: "http://192.168.0.12:3200",
    launcherIcon: "📡",
  }),
  tile({
    clientId: "dss-home",
    name: "회사 홈페이지",
    launcherUrl: "http://192.168.0.12:3300",
    launcherIcon: "🏠",
  }),
];

test("받은 목록을 그대로 옮긴다 — 더하지도 빼지도 않는다", () => {
  // 권한 판정은 listAccessibleClients 하나뿐이다. 이 함수가 목록을 다시
  // 손대면 포털 타일과 메뉴바가 서로 다른 말을 하게 된다.
  assert.deepEqual(
    toServiceMenu(ACCESSIBLE).map((entry) => entry.id),
    ["rf-service-system", "dss-meters", "dss-home"]
  );
});

test("권한이 없어 목록에서 빠진 시스템은 메뉴에도 없다", () => {
  // 걸러진 결과만 들어온다는 계약을 시험으로 적어 둔다. 이 함수는 clients
  // 표를 보지 않으므로, 받지 않은 시스템을 만들어 낼 방법 자체가 없다.
  const withoutMeters = ACCESSIBLE.filter(
    (row) => row.clientId !== "dss-meters"
  );
  const ids = toServiceMenu(withoutMeters).map((entry) => entry.id);
  assert.ok(!ids.includes("dss-meters"), ids.join(","));
  assert.equal(ids.length, 2);
});

test("받은 차례를 유지한다 — 배열 순서가 곧 표시 순서다", () => {
  // listAccessibleClients가 sort_order로 줄을 세워 준다. 순서 값을 따로
  // 싣지 않는 이유가 이것이라, 순서가 흔들리면 안 된다.
  const reversed = [...ACCESSIBLE].reverse();
  assert.deepEqual(
    toServiceMenu(reversed).map((entry) => entry.id),
    ["dss-home", "dss-meters", "rf-service-system"]
  );
});

test("메뉴바가 안 쓰는 값은 담지 않는다", () => {
  const [entry] = toServiceMenu([tile()]);
  // 키 집합을 통째로 못 박는다. 새 칸이 슬그머니 실리면 여기서 걸린다.
  assert.deepEqual(Object.keys(entry).sort(), ["icon", "id", "name", "url"]);
  assert.ok(!("description" in entry));
});

test("설명이 아무리 길어도 토큰에는 실리지 않는다", () => {
  const long = tile({ description: "가".repeat(500) });
  assert.ok(!JSON.stringify(toServiceMenu([long])).includes("가"));
});

test("갈 주소가 없는 시스템은 메뉴에 담지 않는다", () => {
  // 메뉴바는 눌러서 건너가는 것이라 주소 없는 칸은 그릴 수 없다.
  // (포털 타일은 주소가 없어도 뜻이 있어 그대로 보인다 — 칸 수가 다를 수
  //  있고, 그것은 권한과 무관하다.)
  const menu = toServiceMenu([
    tile({ clientId: "no-url", launcherUrl: null }),
    tile({ clientId: "has-url" }),
  ]);
  assert.deepEqual(
    menu.map((entry) => entry.id),
    ["has-url"]
  );
});

test("아이콘이 없으면 키 자체가 없다", () => {
  const [entry] = toServiceMenu([tile({ launcherIcon: null })]);
  assert.ok(!("icon" in entry), JSON.stringify(entry));
  // 나머지는 그대로 실린다 — 아이콘은 있으면 좋은 것일 뿐이다.
  assert.equal(entry.name, "DSS A/S 관리 시스템");
});

test("아이콘이 글자가 아니라 그림 주소면 아이콘만 뺀다", () => {
  // 등록할 때 무엇을 넣는지 막는 장치가 없다. 그림이 들어오면 모든 사람의
  // 모든 로그인 토큰이 그만큼 부푼다 — 그렇다고 로그인을 막지는 않는다.
  const dataUri = `data:image/png;base64,${"A".repeat(2000)}`;
  const [entry] = toServiceMenu([tile({ launcherIcon: dataUri })]);
  assert.ok(!("icon" in entry));
  assert.equal(entry.url, "http://192.168.0.12:3000");
});

test("코드 포인트가 여럿 묶인 이모지는 그대로 싣는다", () => {
  // 국기(🇰🇷)와 가족 이모지는 글자 수가 2~11이다. 상한이 이것들을 잘라내면
  // 멀쩡한 등록값이 이유 없이 빠진다.
  for (const icon of ["🇰🇷", "👨‍👩‍👧‍👦", "🔧"]) {
    const [entry] = toServiceMenu([tile({ launcherIcon: icon })]);
    assert.equal(entry.icon, icon, icon);
  }
});

test("쓸 수 있는 서비스가 없는 사람에게는 빈 목록 — 터지지 않는다", () => {
  assert.deepEqual(toServiceMenu([]), []);
});

test("받는 시스템 자신도 목록에 남는다", () => {
  // 이 토큰의 aud가 rf-service-system이어도 그 칸을 빼지 않는다. 메뉴바가
  // 「지금 여기」를 눌린 상태로 그리려면 자기 칸이 있어야 하고, 포털이 빼면
  // 각 시스템이 제 이름과 주소를 스스로 적어 되살려야 한다.
  const ids = toServiceMenu(ACCESSIBLE).map((entry) => entry.id);
  assert.ok(ids.includes("rf-service-system"));
});

test("받은 배열을 건드리지 않는다", () => {
  const rows = [tile()];
  const before = JSON.stringify(rows);
  toServiceMenu(rows);
  assert.equal(JSON.stringify(rows), before);
});

test("한 칸이 200바이트를 넘지 않는다", () => {
  // 시스템 수만큼 곱해지는 값이다. 여기가 커지면 모든 로그인이 무거워진다.
  const [entry] = toServiceMenu([tile()]);
  const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
  assert.ok(bytes <= 200, `한 칸이 ${bytes}바이트`);
});

test("시스템이 열 개로 늘어도 토큰 증가분이 3KB 안이다", () => {
  // 지금은 셋이고, 한 자릿수를 넘길 계획이 없다(schema/clients.ts). 열
  // 개까지는 이 방식이 감당한다는 것을 숫자로 적어 둔다 — 넘어서면 토큰에
  // 싣지 말고 조회 주소를 따로 내야 한다.
  const many: ClientTile[] = Array.from({ length: 10 }, (_, i) =>
    tile({
      clientId: `dss-system-${i}`,
      name: `제법 긴 한글 시스템 이름 ${i}`,
      launcherUrl: `http://192.168.0.12:3${i}00/dashboard`,
      launcherIcon: "🔧",
    })
  );
  const json = JSON.stringify(toServiceMenu(many));
  // JWT는 payload를 base64url로 싣는다 → 바이트가 4/3배로 늘어난다.
  const inToken = Math.ceil((Buffer.byteLength(json, "utf8") * 4) / 3);
  assert.ok(inToken < 3000, `토큰 증가분 약 ${inToken}바이트`);
});

test("클레임 이름은 다른 규격과 겹치지 않게 접두사를 단다", () => {
  assert.equal(SERVICE_MENU_CLAIM, "dss_services");
});

test("JSON으로 오갈 수 있는 값만 담는다", () => {
  // JWT payload가 되는 값이다. Date나 undefined가 섞이면 서명 단계에서
  // 조용히 모양이 달라진다.
  const menu = toServiceMenu(ACCESSIBLE);
  const roundTrip = JSON.parse(JSON.stringify(menu)) as ServiceMenuEntry[];
  assert.deepEqual(roundTrip, menu);
});
