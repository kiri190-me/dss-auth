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

// ───── Windows 모바일 핫스팟 ─────
//
// 2026-09-13 이 PC에서 포털 issuer가 http://192.168.137.1:3100으로 떴다.
// 실제 Wi-Fi는 192.168.35.215였다. 핫스팟 어댑터 이름("로컬 영역 연결* 12")이
// 가상 어댑터 규칙에 걸리지 않고, 두 주소가 모두 192.168이라 대역 순위도
// 같아서, 마지막 사전순에서 "137"이 "35"보다 앞섰다.
// 이 PC 안의 왕복은 되므로 check:oidc가 못 잡는다. 폰·동료 PC에서만 막힌다.

/** 스냅샷 한 칸을 짧게 쓰려고. */
function v4(address: string) {
  return [{ address, family: "IPv4", internal: false }];
}

/** 2026-09-13 이 PC에서 관측한 모양. 핫스팟이 켜져 있었다. */
const PC_2026_09_13: InterfaceSnapshot = {
  "Wi-Fi 2": v4("192.168.35.215"),
  "로컬 영역 연결* 12": v4("192.168.137.1"),
  "로컬 영역 연결* 11": v4("169.254.142.11"),
  "vEthernet (WSL (Hyper-V firewall))": v4("172.23.224.1"),
  "Bluetooth 네트워크 연결": v4("169.254.114.146"),
  "Loopback Pseudo-Interface 1": [
    { address: "127.0.0.1", family: "IPv4", internal: true },
  ],
};

test("2026-09-13 구성 — Wi-Fi가 핫스팟보다 먼저 온다", () => {
  assert.deepEqual(collectLanAddresses(PC_2026_09_13), [
    "192.168.35.215",
    "192.168.137.1",
    "172.23.224.1",
  ]);
});

test("핫스팟 주소는 버리지 않고 뒤에 남긴다 — 핫스팟을 쓸 때가 있다", () => {
  const addresses = collectLanAddresses(PC_2026_09_13);
  assert.equal(addresses.includes("192.168.137.1"), true);
  assert.ok(addresses.indexOf("192.168.137.1") > addresses.indexOf("192.168.35.215"));
  // 등록 주소를 펼친 후보에도 남는다. 핫스팟에 붙은 폰의 redirect_uri가 통과한다.
  assert.equal(
    expandLanPlaceholder("http://{lan}:3000/cb", addresses).includes(
      "http://192.168.137.1:3000/cb"
    ),
    true
  );
});

test("2026-09-14 구성(Wi-Fi 192.168.1.132)도 같은 순서다", () => {
  // 이날은 사전순이 우연히 맞아("1." < "13") 증상이 보이지 않았다.
  const snapshot: InterfaceSnapshot = { ...PC_2026_09_13, "Wi-Fi 2": v4("192.168.1.132") };
  assert.deepEqual(collectLanAddresses(snapshot), [
    "192.168.1.132",
    "192.168.137.1",
    "172.23.224.1",
  ]);
});

test("192.168.2.x Wi-Fi도 핫스팟보다 먼저 온다", () => {
  const snapshot: InterfaceSnapshot = {
    "Wi-Fi": v4("192.168.2.40"),
    "로컬 영역 연결* 12": v4("192.168.137.1"),
  };
  assert.deepEqual(collectLanAddresses(snapshot), ["192.168.2.40", "192.168.137.1"]);
});

test("영문 Windows의 핫스팟 어댑터 이름도 알아본다", () => {
  const snapshot: InterfaceSnapshot = {
    "Wi-Fi": v4("192.168.35.215"),
    "Local Area Connection* 3": v4("192.168.137.1"),
  };
  assert.deepEqual(collectLanAddresses(snapshot), ["192.168.35.215", "192.168.137.1"]);
});

test("핫스팟 대역을 바꾼 PC도 어댑터 이름으로 알아본다", () => {
  // 인터넷 연결 공유의 대역은 레지스트리로 바꿀 수 있다. 주소 표지가 빗나간다.
  for (const name of ["로컬 영역 연결* 12", "Local Area Connection* 12"]) {
    const snapshot: InterfaceSnapshot = {
      "Wi-Fi": v4("192.168.35.215"),
      [name]: v4("192.168.10.1"),
    };
    assert.deepEqual(collectLanAddresses(snapshot), ["192.168.35.215", "192.168.10.1"], name);
  }
});

test("이름을 몰라도 192.168.137 대역이면 핫스팟으로 본다", () => {
  // 인터넷 연결 공유로 이더넷 포트를 내주면 그 포트가 192.168.137.1을 받는다.
  const snapshot: InterfaceSnapshot = {
    "Wi-Fi": v4("192.168.35.215"),
    "이더넷 2": v4("192.168.137.1"),
  };
  assert.deepEqual(collectLanAddresses(snapshot), ["192.168.35.215", "192.168.137.1"]);
});

test("별표 없는 'Local Area Connection 2'는 진짜 랜카드다 — 밀지 않는다", () => {
  // 옛 Windows는 유선 랜카드를 이렇게 불렀다. 핫스팟은 이름에 별표가 붙는다.
  const snapshot: InterfaceSnapshot = {
    "Local Area Connection 2": v4("192.168.35.215"),
    "Local Area Connection* 12": v4("192.168.10.1"),
  };
  assert.deepEqual(collectLanAddresses(snapshot), ["192.168.35.215", "192.168.10.1"]);
});

test("아이폰 핫스팟에 붙은 Wi-Fi(172.20.10.x)가 이 PC 자신의 핫스팟보다 먼저 온다", () => {
  // 대역 순위만 보면 192.168이 172보다 앞선다. 층이 대역보다 먼저여야 한다.
  const snapshot: InterfaceSnapshot = {
    "Wi-Fi 2": v4("172.20.10.4"),
    "로컬 영역 연결* 12": v4("192.168.137.1"),
    "vEthernet (WSL (Hyper-V firewall))": v4("172.23.224.1"),
  };
  assert.deepEqual(collectLanAddresses(snapshot), [
    "172.20.10.4",
    "192.168.137.1",
    "172.23.224.1",
  ]);
});

test("진짜 어댑터가 없으면 핫스팟이 가상 어댑터보다 먼저다", () => {
  // 핫스팟은 폰이 실제로 붙는 망이고, 가상 어댑터는 이 PC 밖에서 닿지 않는다.
  // 둘을 한 층에 두었다면 사전순으로 VMware(192.168.100.1)가 앞섰다.
  const snapshot: InterfaceSnapshot = {
    "VMware Network Adapter VMnet8": v4("192.168.100.1"),
    "로컬 영역 연결* 12": v4("192.168.137.1"),
    "vEthernet (WSL (Hyper-V firewall))": v4("172.23.224.1"),
  };
  assert.deepEqual(collectLanAddresses(snapshot), [
    "192.168.137.1",
    "192.168.100.1",
    "172.23.224.1",
  ]);
});

test("남의 Windows 핫스팟에 붙어 192.168.137.x를 받은 Wi-Fi도 혼자면 첫째다", () => {
  // 주소 표지는 뒤로 밀 뿐이라, 다른 진짜 어댑터가 없으면 여전히 첫째다.
  const snapshot: InterfaceSnapshot = {
    "Wi-Fi 2": v4("192.168.137.23"),
    "vEthernet (WSL (Hyper-V firewall))": v4("172.23.224.1"),
  };
  assert.deepEqual(collectLanAddresses(snapshot), ["192.168.137.23", "172.23.224.1"]);
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
