import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIdTokenPayload, type IdTokenClaims } from "./id-token-payload";
import { SERVICE_MENU_CLAIM, type ServiceMenuEntry } from "./service-menu";

const AUTH_TIME = new Date("2026-09-17T01:02:03.456Z");

const MENU: ServiceMenuEntry[] = [
  { id: "rf-service-system", name: "DSS A/S 관리 시스템", url: "http://192.168.0.12:3000", icon: "🔧" },
];

function claims(over: Partial<IdTokenClaims> = {}): IdTokenClaims {
  return {
    subject: "3f0f6f2e-0000-4000-8000-000000000001",
    audience: "rf-service-system",
    nonce: "n".repeat(43),
    sessionId: "3f0f6f2e-0000-4000-8000-000000000002",
    authTime: AUTH_TIME,
    name: "홍길동",
    email: "hong@example.com",
    role: "AS_ENGINEER",
    services: MENU,
    ...over,
  };
}

/**
 * 서비스 목록이 붙기 전에 나가던 클레임. 하나라도 사라지거나 값이 달라지면
 * 이미 붙어 있는 시스템의 로그인이 조용히 달라진다.
 */
const CLAIMS_BEFORE_SERVICE_MENU = [
  "nonce",
  "sid",
  "auth_time",
  "name",
  "preferred_username",
  "email",
  "email_verified",
  "role",
];

test("옛 클라이언트가 읽던 클레임이 값까지 그대로다", () => {
  const payload = buildIdTokenPayload(claims());
  assert.equal(payload.nonce, "n".repeat(43));
  assert.equal(payload.sid, "3f0f6f2e-0000-4000-8000-000000000002");
  assert.equal(payload.auth_time, Math.floor(AUTH_TIME.getTime() / 1000));
  assert.equal(payload.name, "홍길동");
  assert.equal(payload.preferred_username, "홍길동");
  assert.equal(payload.email, "hong@example.com");
  assert.equal(payload.email_verified, false);
  // A/S 시스템(sso-login.ts)이 읽는 세 값이 role·email·name이다.
  assert.equal(payload.role, "AS_ENGINEER");
});

test("서비스 목록 말고 새로 실린 것은 없다", () => {
  // 늘어난 클레임이 딱 하나임을 못 박는다. 토큰에 무엇이 실리는지는
  // 붙어 있는 시스템 전부에 영향을 주므로 슬그머니 늘면 안 된다.
  const keys = Object.keys(buildIdTokenPayload(claims())).sort();
  assert.deepEqual(
    keys,
    [...CLAIMS_BEFORE_SERVICE_MENU, SERVICE_MENU_CLAIM].sort()
  );
});

test("이 클레임을 모르는 옛 클라이언트의 로그인이 그대로 돈다", () => {
  // 받는 쪽이 읽는 클레임만 골라 보면, 목록이 있든 없든 답이 같아야 한다.
  const read = (payload: Record<string, unknown>) => ({
    sub: "검증 단계에서 온다",
    role: payload.role,
    email: payload.email,
    name: payload.name,
  });
  assert.deepEqual(
    read(buildIdTokenPayload(claims({ services: MENU }))),
    read(buildIdTokenPayload(claims({ services: [] })))
  );
});

test("역할이 없으면 role 클레임 자체가 없다", () => {
  // "안 왔다"와 "빈 값이 왔다"는 다르다. 빈 문자열을 싣지 않는다.
  const payload = buildIdTokenPayload(claims({ role: null }));
  assert.ok(!("role" in payload));
});

test("이메일이 없으면 email과 email_verified 둘 다 없다", () => {
  const payload = buildIdTokenPayload(claims({ email: null }));
  assert.ok(!("email" in payload));
  assert.ok(!("email_verified" in payload));
});

test("서비스 목록이 그대로 실린다", () => {
  const payload = buildIdTokenPayload(claims());
  assert.deepEqual(payload[SERVICE_MENU_CLAIM], MENU);
});

test("쓸 수 있는 서비스가 없어도 빈 배열로 실린다", () => {
  // email·role과 일부러 다르다. 클레임이 있느냐 없느냐가 받는 쪽에게는
  // "이 포털이 메뉴바를 지원하는가"의 표지라, 사람마다 나타났다 사라지면
  // 그 판단을 할 수 없다.
  const payload = buildIdTokenPayload(claims({ services: [] }));
  assert.ok(SERVICE_MENU_CLAIM in payload);
  assert.deepEqual(payload[SERVICE_MENU_CLAIM], []);
});

test("iss·sub·aud·iat·exp는 여기서 만들지 않는다", () => {
  // 그것들은 SignJWT의 전용 설정으로 넣어야 형식이 보장된다(id-token.ts).
  // 여기서 손으로 넣으면 두 곳이 서로 다른 값을 쓸 수 있다.
  const payload = buildIdTokenPayload(claims());
  for (const key of ["iss", "sub", "aud", "iat", "exp"]) {
    assert.ok(!(key in payload), `payload가 ${key}를 직접 넣고 있다`);
  }
});

test("auth_time은 초 단위 정수다", () => {
  // 밀리초로 나가면 받는 쪽이 3만 년 뒤의 인증으로 읽는다.
  const payload = buildIdTokenPayload(claims());
  assert.equal(typeof payload.auth_time, "number");
  assert.equal(payload.auth_time, 1789606923);
});

test("payload가 JSON으로 직렬화된다", () => {
  assert.doesNotThrow(() =>
    JSON.parse(JSON.stringify(buildIdTokenPayload(claims())))
  );
});
