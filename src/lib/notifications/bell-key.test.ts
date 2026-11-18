import assert from "node:assert/strict";
import { test } from "node:test";
import { readBellKey } from "./bell-key";
import { NOTIFICATION_SOURCE_PATHS } from "./sources";

/**
 * ============================================================================
 * 🔴 여기 들어오는 값은 **브라우저를 거쳐 온 것**이다
 * ============================================================================
 * 서버 액션의 인자는 타입이 적혀 있어도 그 모양으로 오지 않는다 — tsc 가
 * 지키는 범위 밖이다. 그래서 아래 시험의 절반은 **타입이 거짓말을 하는
 * 경우**다(숫자·배열·null·프로토타입만 가진 객체).
 *
 * 재는 것 넷:
 *  🔴 무엇이 와도 **던지지 않는다** — 던지면 ✕ 를 누른 사람 화면에 오류가 뜬다
 *  🔴 모르는 시스템의 열쇠는 **안 적는다**(표가 길이 제한 없는 text 다)
 *  🔴 가르는 규칙이 `parseDismissalKey` 와 **같다** — 첫 `:` 에서만 가른다
 *  🔴 프로토타입 이름이 **등록된 시스템인 척** 통과하지 않는다
 *
 * 🔴 값은 전부 가짜다 — 사람 이름도 고객사도 실제 건 번호도 들어 있지 않다.
 * ============================================================================
 */

/** 알림 통로를 가진 시스템. 🔴 목록은 상수가 말한다 — 여기 또 적지 않는다. */
const KNOWN = Object.keys(NOTIFICATION_SOURCE_PATHS);

test("🔴 알림 통로를 가진 시스템의 열쇠는 그대로 나온다 — 여섯 전부", () => {
  // 🔵 표본이 비면 아래 for 가 공짜로 통과한다. 수가 줄면(통로가 닫히면)
  //    여기서 먼저 걸려 「왜 줄었나」를 묻게 된다.
  assert.ok(KNOWN.length >= 6, `알림 통로가 ${KNOWN.length}곳뿐이다`);

  for (const clientId of KNOWN) {
    const key = `${clientId}:FAKE-0001`;
    assert.equal(readBellKey({ key }), key, clientId);
  }
});

test("🔴 첫 `:` 에서만 가른다 — id 안의 `:` 는 손대지 않는다", () => {
  // A/S 의 id 에는 실제로 `:` 가 있다(「종류:대상」 모양). 마지막 `:` 에서
  // 가르거나 split 으로 조각을 세면 그 열쇠들이 전부 떨어지고, 증상은
  // 「지웠는데 그대로 뜬다」 하나뿐이라 어디가 틀렸는지 가리키지 않는다.
  const key = "rf-service-system:FAKE_APPROVAL:RC-0000-0000";
  assert.equal(readBellKey({ key }), key);
});

test("🔴 알림 통로가 없는 시스템의 열쇠는 안 적는다", () => {
  // 계측기·PO·승인함은 제 알림이 없어 `…:1` 이라는 열쇠가 어디서도 만들어지지
  // 않는다. 모양만 맞는 글자를 받아 적으면 표에 쓰레기가 쌓인다.
  const strangers = ["dss-meters", "dss-po", "dss-approvals", "dss-home", "없는시스템"];
  for (const clientId of strangers) {
    // 표본이 거꾸로 서지 않게 — 이 다섯이 정말 목록 밖인지 먼저 본다.
    assert.equal(Object.hasOwn(NOTIFICATION_SOURCE_PATHS, clientId), false, clientId);
    assert.equal(readBellKey({ key: `${clientId}:FAKE-0001` }), null, clientId);
  }
});

test("🔴 프로토타입 이름이 등록된 시스템인 척 통과하지 않는다", () => {
  // `in` 으로 물으면 `constructor:x` 가 참이 되어 그대로 표에 적힌다.
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.equal(readBellKey({ key: `${name}:FAKE-0001` }), null, name);
  }
});

test("모양이 열쇠가 아니면 null — 어느 시스템인지·어느 알림인지가 없다", () => {
  for (const key of [":FAKE-0001", "rf-service-system:", "rf-service-system", "", "   ", ":"]) {
    assert.equal(readBellKey({ key }), null, JSON.stringify(key));
  }
});

test("앞뒤 공백은 턴다 — 열쇠는 글자로 날아다닌다", () => {
  assert.equal(readBellKey({ key: "  dss-leave:FAKE-0001  " }), "dss-leave:FAKE-0001");
});

test("🔴 타입이 거짓말을 해도 던지지 않는다 — 줄이 아닌 것이 올 수 있다", () => {
  const liars: unknown[] = [
    null,
    undefined,
    "dss-leave:FAKE-0001", // 객체가 아니라 글자 하나로 왔다
    7,
    true,
    [],
    ["dss-leave:FAKE-0001"],
    {},
    { key: 7 },
    { key: null },
    { key: ["dss-leave:FAKE-0001"] },
    { notKey: "dss-leave:FAKE-0001" },
    Object.create(null), // 프로토타입이 없는 객체 — `.key` 조회가 터지지 않는다
  ];
  assert.ok(liars.length >= 13, "표본이 비면 아래가 공짜로 통과한다");

  for (const [index, liar] of liars.entries()) {
    // 🔵 이름표에 값을 적지 않는다 — `String(Object.create(null))` 자체가
    //    던져서(toString 이 없다) **시험이 제 이름표에 걸려 넘어진다.**
    //    실제로 한 번 그렇게 깨졌다. 자리 번호면 어느 줄인지 찾기에 충분하다.
    assert.doesNotThrow(() => readBellKey(liar), `${index}번이 던졌다`);
    assert.equal(readBellKey(liar), null, `${index}번이 통과했다`);
  }
});

test("🔴 길이로 거르지 않는다 — 상한은 이 함수의 일이 아니다", () => {
  // 한 요청의 **개수** 상한은 일괄 통로에 있고(dismissals.ts 의
  // MAX_DISMISSAL_KEYS_PER_REQUEST), 여기는 줄 하나짜리다. 글자 수 상한을
  // 여기서 새로 지어내면 포털과 사이트가 서로 다른 잣대를 갖게 된다 —
  // 「사이트에서 지우면 되는데 포털에서 지우면 안 되는」 줄이 생긴다.
  const long = `dss-board:${"0".repeat(500)}`;
  assert.equal(readBellKey({ key: long }), long);
});
