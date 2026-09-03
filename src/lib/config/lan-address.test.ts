import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectLanAddresses,
  expandLanPlaceholder,
  expandLanPlaceholders,
  hasLanPlaceholder,
  resolveAutoUrl,
  type InterfaceSnapshot,
} from "./lan-address";

/** 이 개발 PC에서 실제로 관측한 모양. WSL도 사설 대역을 들고 있다. */
const REAL_PC: InterfaceSnapshot = {
  "Wi-Fi 2": [{ address: "192.168.0.13", family: "IPv4", internal: false }],
  "Loopback Pseudo-Interface 1": [
    { address: "127.0.0.1", family: "IPv4", internal: true },
  ],
  "vEthernet (WSL (Hyper-V firewall))": [
    { address: "172.23.224.1", family: "IPv4", internal: false },
  ],
};

test("진짜 랜카드가 WSL보다 먼저 온다", () => {
  assert.deepEqual(collectLanAddresses(REAL_PC), ["192.168.0.13", "172.23.224.1"]);
});

test("루프백은 제외한다", () => {
  assert.equal(collectLanAddresses(REAL_PC).includes("127.0.0.1"), false);
});

test("링크로컬(169.254)은 제외한다 — 주소를 못 받았다는 뜻이다", () => {
  const snapshot: InterfaceSnapshot = {
    "블루투스 네트워크 연결": [
      { address: "169.254.114.146", family: "IPv4", internal: false },
    ],
    "이더넷": [{ address: "10.0.0.5", family: "IPv4", internal: false }],
  };
  assert.deepEqual(collectLanAddresses(snapshot), ["10.0.0.5"]);
});

test("family를 숫자 4로 주는 Node에서도 같게 동작한다", () => {
  const snapshot: InterfaceSnapshot = {
    "이더넷": [{ address: "192.168.1.50", family: 4, internal: false }],
  };
  assert.deepEqual(collectLanAddresses(snapshot), ["192.168.1.50"]);
});

test("IPv6는 보지 않는다", () => {
  const snapshot: InterfaceSnapshot = {
    "Wi-Fi": [
      { address: "fe80::1", family: "IPv6", internal: false },
      { address: "192.168.0.13", family: "IPv4", internal: false },
    ],
  };
  assert.deepEqual(collectLanAddresses(snapshot), ["192.168.0.13"]);
});

test("어댑터 이름이 낯설어도 사설 대역 순위가 한 번 더 걸러준다", () => {
  // 이름 규칙(VIRTUAL_ADAPTER)에 걸리지 않는 가상 어댑터를 가정한다.
  const snapshot: InterfaceSnapshot = {
    "Some Virtual NIC": [
      { address: "172.20.0.1", family: "IPv4", internal: false },
    ],
    "Wi-Fi": [{ address: "192.168.0.13", family: "IPv4", internal: false }],
  };
  assert.equal(collectLanAddresses(snapshot)[0], "192.168.0.13");
});

test("순서가 실행마다 흔들리지 않는다", () => {
  const snapshot: InterfaceSnapshot = {
    b: [{ address: "192.168.0.20", family: "IPv4", internal: false }],
    a: [{ address: "192.168.0.10", family: "IPv4", internal: false }],
  };
  assert.deepEqual(collectLanAddresses(snapshot), ["192.168.0.10", "192.168.0.20"]);
});

test("쓸 주소가 없으면 빈 목록", () => {
  assert.deepEqual(collectLanAddresses({}), []);
});

// ───── 자리표시자 ─────

test("호스트 자리에 있을 때만 자리표시자로 본다", () => {
  assert.equal(hasLanPlaceholder("http://{lan}:3000/cb"), true);
  assert.equal(hasLanPlaceholder("http://{lan}/cb"), true);
  // 경로·쿼리에 우연히 같은 글자가 있는 경우는 대상이 아니다.
  assert.equal(hasLanPlaceholder("https://as.dss.example/{lan}"), false);
  assert.equal(hasLanPlaceholder("https://as.dss.example/cb?to={lan}"), false);
  assert.equal(hasLanPlaceholder("https://as.dss.example/cb"), false);
  assert.equal(hasLanPlaceholder("not a url"), false);
});

test("자리표시자를 주소마다 하나씩 펼친다", () => {
  assert.deepEqual(
    expandLanPlaceholder("http://{lan}:3000/api/auth/sso/callback", [
      "192.168.0.13",
      "172.23.224.1",
    ]),
    [
      "http://192.168.0.13:3000/api/auth/sso/callback",
      "http://172.23.224.1:3000/api/auth/sso/callback",
    ]
  );
});

test("펼칠 때 포트도 경로도 손대지 않는다 — 정규화는 곧 비교 실패다", () => {
  // URL 객체로 재조립했다면 :80이 사라졌을 값이다.
  assert.deepEqual(expandLanPlaceholder("http://{lan}:80/cb/", ["10.0.0.5"]), [
    "http://10.0.0.5:80/cb/",
  ]);
});

test("자리표시자가 없으면 원본 그대로", () => {
  const uri = "https://as.dss.example/api/auth/sso/callback";
  assert.deepEqual(expandLanPlaceholder(uri, ["192.168.0.13"]), [uri]);
});

test("주소를 못 찾으면 아무것도 통과시키지 않는다 — 막히는 쪽으로 실패한다", () => {
  assert.deepEqual(expandLanPlaceholder("http://{lan}:3000/cb", []), []);
});

test("목록을 통째로 펼치면 고정 주소와 자리표시자가 섞여도 된다", () => {
  assert.deepEqual(
    expandLanPlaceholders(
      ["https://as.dss.example/cb", "http://{lan}:3000/cb"],
      ["192.168.0.13"]
    ),
    ["https://as.dss.example/cb", "http://192.168.0.13:3000/cb"]
  );
});

// ───── auto ─────

test("auto는 이 기계 주소와 기본 포트로 풀린다", () => {
  assert.equal(resolveAutoUrl("auto", 3100, "192.168.0.13"), "http://192.168.0.13:3100");
});

test("auto:포트로 포트를 지정할 수 있다", () => {
  assert.equal(resolveAutoUrl("auto:3300", 3100, "192.168.0.13"), "http://192.168.0.13:3300");
});

test("auto가 아니면 적힌 값을 그대로 쓴다", () => {
  const fixed = "https://sso.dss.example";
  assert.equal(resolveAutoUrl(fixed, 3100, "192.168.0.13"), fixed);
});

test("auto: 뒤에 포트가 아닌 값이 오면 멈춘다", () => {
  assert.throws(() => resolveAutoUrl("auto:abc", 3100, "192.168.0.13"), /포트 번호/);
});
