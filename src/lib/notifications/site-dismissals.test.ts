import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DISMISSAL_KEYS_PER_REQUEST } from "./dismissals";
import type { PortalNotificationFeed } from "./merge";
import { handleDismissalRequest, type DismissalDeps } from "./site-dismissals";
import { handleSiteFeedRequest, type SiteFeedDeps, type SiteRequestDeps } from "./site-feed";

/**
 * ============================================================================
 * 쓰기 통로 — **거절이 전부이고, 거절의 모양이 읽기 통로와 같아야 한다**
 * ============================================================================
 * 읽기 통로에서 뚫리면 새는 것이 「남의 밀린 일 건수」였다. 쓰기에서 뚫리면
 * **아무 사람의 알림이나 숨길 수 있다**(설계안 5절 ③). 그래서 아래 시험들이
 * 못 박는 것은 둘이다:
 *
 *  1. 문 여섯이 읽기 통로와 **똑같이** 막는가 — 그리고 막혔을 때 `record` 가
 *     **한 번도 불리지 않는가.** 이것이 이 파일에서 가장 중요한 줄이다.
 *  2. 인증을 통과하지 못한 쪽에 **열쇠 검사 결과가 새지 않는가** — 새면 이
 *     통로가 「이 열쇠 모양이 맞나」를 물어보는 도구가 된다.
 * ============================================================================
 */

const URL_BASE = "https://portal.example/api/integration/notification-dismissals";
const CLIENT = { clientId: "rf-service-system" };
const USER = "11111111-1111-4111-8111-111111111111";

/** 🔵 A/S 의 알림 id 에는 `:` 가 들어 있다(「종류:대상」). 열쇠는 그 앞에 붙는다. */
const KEY = "rf-service-system:REPAIR_CASE_APPROVAL:RC-2026-0001";

const FEED: PortalNotificationFeed = { items: [], count: 0, sources: [], degraded: false };

function basic(clientId: string, clientSecret: string): string {
  const raw = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

function post(options: { authorization?: string; body?: string; url?: string; keys?: string[] } = {}): Request {
  const keys = options.keys ?? [KEY];
  const body = options.body ?? `sub=${USER}&keys=${encodeURIComponent(keys.join(","))}`;
  return new Request(options.url ?? URL_BASE, {
    method: "POST",
    headers: options.authorization ? { authorization: options.authorization } : {},
    body,
  });
}

type Over = {
  client?: { clientId: string } | null;
  secretOk?: boolean;
  user?: { status: string } | null;
  access?: boolean;
  limited?: boolean;
};

type Calls = {
  findActiveClient: string[];
  findUser: string[];
  hasAccess: string[];
  record: { userId: string; keys: string[] }[];
  authFailures: number;
};

function emptyCalls(): Calls {
  return { findActiveClient: [], findUser: [], hasAccess: [], record: [], authFailures: 0 };
}

/** 문 여섯의 재료. 🔴 읽기 통로 시험과 **같은 값**을 주려고 한 곳에 둔다. */
function gates(over: Over, calls: Calls): SiteRequestDeps<{ clientId: string }> {
  return {
    async findActiveClient(clientId) {
      calls.findActiveClient.push(clientId);
      return over.client === undefined ? CLIENT : over.client;
    },
    verifySecret() {
      return over.secretOk ?? true;
    },
    async findUser(userId) {
      calls.findUser.push(userId);
      return over.user === undefined ? { status: "ACTIVE" } : over.user;
    },
    async hasAccess(userId) {
      calls.hasAccess.push(userId);
      return over.access ?? true;
    },
    countAuthFailure() {
      calls.authFailures += 1;
      return over.limited
        ? { allowed: false, retryAfterSeconds: 7, firstRejection: true }
        : { allowed: true, retryAfterSeconds: 0, firstRejection: false };
    },
  };
}

function makeDeps(over: Over = {}): { deps: DismissalDeps<{ clientId: string }>; calls: Calls } {
  const calls = emptyCalls();
  const deps: DismissalDeps<{ clientId: string }> = {
    ...gates(over, calls),
    async record(params) {
      calls.record.push({ userId: params.userId, keys: [...params.keys] });
    },
  };
  return { deps, calls };
}

/** 같은 문 여섯을 가진 읽기 통로. 두 통로의 거절을 맞대 보려고 쓴다. */
function makeFeedDeps(over: Over = {}): SiteFeedDeps<{ clientId: string }> {
  return {
    ...gates(over, emptyCalls()),
    async feedFor() {
      return FEED;
    },
  };
}

function errorOf(body: unknown): string {
  return (body as { error?: string }).error ?? "";
}

function descriptionOf(body: unknown): string {
  return String((body as { error_description?: string }).error_description ?? "");
}

function recordedOf(body: unknown): { recorded: number; dropped: number } {
  return body as { recorded: number; dropped: number };
}

const HEADER = basic("rf-service-system", "맞는값");

/**
 * 문 여섯이 막는 일곱 가지. 🔴 **이 목록이 두 통로의 계약이다** — 하나가
 * 빠지면 그 문이 쓰기 쪽에서만 열려 있다는 뜻이고, 쓰기 쪽이 열리면 아무
 * 사람의 알림이나 숨길 수 있다.
 */
const BLOCKED: { name: string; over: Over; options: Parameters<typeof post>[0] }[] = [
  { name: "자격증명이 없다", over: {}, options: {} },
  { name: "Bearer 로는 못 들어온다", over: {}, options: { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.x.y" } },
  { name: "시크릿이 틀렸다", over: { secretOk: false }, options: { authorization: HEADER } },
  { name: "등록되지 않은 시스템이다", over: { client: null }, options: { authorization: HEADER } },
  { name: "없는(삭제된) 사람이다", over: { user: null }, options: { authorization: HEADER } },
  { name: "정지된 사람이다", over: { user: { status: "SUSPENDED" } }, options: { authorization: HEADER } },
  { name: "승인 대기인 사람이다", over: { user: { status: "PENDING" } }, options: { authorization: HEADER } },
  { name: "그 시스템에 들어갈 수 없는 사람이다", over: { access: false }, options: { authorization: HEADER } },
  { name: "주소에 비밀값이 실려 있다", over: {}, options: { url: `${URL_BASE}?client_secret=샌값` } },
];

// ───────────────────────────────────────────────── 문 여섯

test("🔴 문 여섯이 읽기 통로와 **똑같이** 막는다 — 상태·본문·머리말·로그 까닭이 같다", async () => {
  for (const blocked of BLOCKED) {
    const write = await handleDismissalRequest(post(blocked.options), makeDeps(blocked.over).deps);
    const read = await handleSiteFeedRequest(post(blocked.options), makeFeedDeps(blocked.over));

    // 베끼지 않고 한 벌(authorizeSiteRequest)을 나눠 쓰므로 갈라질 길이 없다.
    // 이 시험은 그 한 벌이 실제로 나눠 쓰이고 있는지를 못 박는다.
    assert.equal(write.status, read.status, blocked.name);
    assert.deepEqual(write.body, read.body, blocked.name);
    assert.deepEqual(write.headers, read.headers, blocked.name);
    assert.equal(write.logReason, read.logReason, blocked.name);
  }
});

test("🔴 거절되면 `record` 가 **한 번도** 불리지 않는다", async () => {
  // 이 파일에서 가장 중요한 줄이다. 여기가 뚫리면 문 여섯이 전부 무의미해진다 —
  // 거절된 요청이 표에 행을 남기면, 막았다는 말은 응답 모양뿐이기 때문이다.
  for (const blocked of BLOCKED) {
    const { deps, calls } = makeDeps(blocked.over);
    const result = await handleDismissalRequest(post(blocked.options), deps);

    assert.notEqual(result.status, 200, blocked.name);
    assert.deepEqual(calls.record, [], blocked.name);
  }
});

test("🔴 권한 없는 시스템은 그 사람의 알림을 지울 수 없다 — 읽기보다 더 중요한 자리다", async () => {
  // 읽기에서 새는 것은 「밀린 일 건수」지만, 여기서 뚫리면 **그 사람의 알림을
  // 아무나 숨길 수 있다**(설계안 5절 ③). 같은 문이지만 값이 다르다.
  const { deps, calls } = makeDeps({ access: false });
  const result = await handleDismissalRequest(post({ authorization: HEADER }), deps);

  assert.equal(result.status, 403);
  assert.equal(errorOf(result.body), "forbidden");
  assert.deepEqual(calls.hasAccess, [USER]);
  assert.deepEqual(calls.record, []);
});

test("인증 없이 두드리면 DB 를 건드리지도 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDismissalRequest(post(), deps);

  assert.equal(result.status, 401);
  assert.equal(result.headers["www-authenticate"], 'Basic realm="dss-auth"');
  assert.deepEqual(calls.findActiveClient, []);
  assert.deepEqual(calls.record, []);
});

test("sub 가 없으면 400 — 누구의 지움인지 모르는 요청은 적지 않는다", async () => {
  const { deps, calls } = makeDeps();
  for (const body of ["", `keys=${KEY}`, `sub=&keys=${KEY}`]) {
    const result = await handleDismissalRequest(post({ authorization: HEADER, body }), deps);
    assert.equal(result.status, 400, body);
    assert.equal(errorOf(result.body), "invalid_request", body);
  }
  assert.deepEqual(calls.record, []);
});

// ───────────────────────────────────────────────── 문 일곱·여덟은 **뒤**에 있다

test("🔴 인증을 통과하지 못하면 열쇠 검사 결과가 새지 않는다 — 401 이지 400 이 아니다", async () => {
  // 새면 이 통로가 「이 열쇠 모양이 맞나」를 물어보는 도구가 된다. 400 과 401 을
  // 갈라 보는 것만으로 열쇠 규칙과 **등록된 알림 시스템 목록**을 짚어 낼 수 있다.
  const { deps, calls } = makeDeps();
  const result = await handleDismissalRequest(post({ keys: ["접두사없음", "없는시스템:1"] }), deps);

  assert.equal(result.status, 401);
  assert.equal(errorOf(result.body), "invalid_client");
  assert.deepEqual(calls.record, []);
});

test("🔴 열쇠가 하나도 없어도 권한이 없으면 403 — 열쇠 검사는 문 여섯 **뒤**다", async () => {
  // 열쇠 검사가 앞에 있으면 이 요청이 400 을 받는다. 그 400 은 「자격은 맞는데
  // 열쇠만 틀렸다」로 읽혀, 권한이 없는 시스템에 **그 사실을 알려 준다.**
  const { deps, calls } = makeDeps({ access: false });
  const result = await handleDismissalRequest(post({ authorization: HEADER, keys: [] }), deps);

  assert.equal(result.status, 403);
  assert.deepEqual(calls.record, []);
});

// ───────────────────────────────────────────────── 열쇠

test("지울 열쇠가 없으면 400 — 적을 것이 없는 요청은 표를 건드리지 않는다", async () => {
  const { deps, calls } = makeDeps();
  for (const body of [`sub=${USER}`, `sub=${USER}&keys=`, `sub=${USER}&keys=,,`]) {
    const result = await handleDismissalRequest(post({ authorization: HEADER, body }), deps);
    assert.equal(result.status, 400, body);
    assert.equal(errorOf(result.body), "invalid_request", body);
  }
  assert.deepEqual(calls.record, []);
});

test("보낸 열쇠가 전부 쓰레기여도 400 — 「아무것도 안 보냈다」와 같은 얼굴이다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDismissalRequest(
    post({ authorization: HEADER, keys: ["접두사없음", ":앞이비었다", "없는시스템:1"] }),
    deps
  );

  assert.equal(result.status, 400);
  assert.deepEqual(calls.record, []);
});

test(`🔴 상한(${MAX_DISMISSAL_KEYS_PER_REQUEST})을 넘으면 400 이고 **나눠 보내라**고 말해 준다`, async () => {
  const tooMany = Array.from(
    { length: MAX_DISMISSAL_KEYS_PER_REQUEST + 1 },
    (_, i) => `rf-service-system:${i}`
  );
  const { deps, calls } = makeDeps();
  const result = await handleDismissalRequest(post({ authorization: HEADER, keys: tooMany }), deps);

  assert.equal(result.status, 400);
  assert.equal(errorOf(result.body), "invalid_request");
  // 🔴 이 말이 없으면 붙이는 쪽은 무엇을 고쳐야 할지 모른다 — 상한을 올려
  // 달라고 하거나 지움을 통째로 포기한다.
  assert.match(descriptionOf(result.body), new RegExp(String(MAX_DISMISSAL_KEYS_PER_REQUEST)));
  assert.match(descriptionOf(result.body), /나눠/);
  // 🔴 **자르지 않는다.** 앞의 200개만 조용히 받으면 사람은 전부 지웠다고 믿는다.
  assert.deepEqual(calls.record, []);
});

test(`정확히 ${MAX_DISMISSAL_KEYS_PER_REQUEST}개는 통과한다 — 경계는 넘지 않은 쪽이다`, async () => {
  const exact = Array.from(
    { length: MAX_DISMISSAL_KEYS_PER_REQUEST },
    (_, i) => `rf-service-system:${i}`
  );
  const { deps, calls } = makeDeps();
  const result = await handleDismissalRequest(post({ authorization: HEADER, keys: exact }), deps);

  assert.equal(result.status, 200);
  assert.equal(recordedOf(result.body).recorded, MAX_DISMISSAL_KEYS_PER_REQUEST);
  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].keys.length, MAX_DISMISSAL_KEYS_PER_REQUEST);
});

test("🔴 모양이 틀린 열쇠가 섞여도 나머지는 적힌다 — 한 줄이 일괄을 무너뜨리지 않는다", async () => {
  // 일괄 지우기가 통째로 실패하면 사람이 할 수 있는 일이 없다 — 어느 줄이
  // 문제인지 화면에 나오지도 않고, 하나씩 지워 볼 수도 없다.
  const { deps, calls } = makeDeps();
  const result = await handleDismissalRequest(
    post({ authorization: HEADER, keys: [KEY, "접두사없음", "dss-po:1", "dss-leave:7"] }),
    deps
  );

  assert.equal(result.status, 200);
  // 🔴 dss-po 는 **제 알림이 없는 시스템**이라 그런 열쇠는 어디서도 만들어지지
  // 않는다 — 모르는 시스템으로 버려진다(dismissals.ts).
  assert.deepEqual(recordedOf(result.body), { recorded: 2, dropped: 2 });
  assert.deepEqual(calls.record, [{ userId: USER, keys: [KEY, "dss-leave:7"] }]);
});

test("🔴 `record` 는 **걸러진 열쇠로만** 불린다 — 쓰레기가 표에 닿지 않는다", async () => {
  const { deps, calls } = makeDeps();
  await handleDismissalRequest(
    post({ authorization: HEADER, keys: ["없는시스템:1", KEY, "constructor:x"] }),
    deps
  );

  // 🔵 `constructor:x` 는 프로토타입을 타고 「등록된 시스템인 척」 통과할 수 있는
  // 모양이다. dismissals.ts 가 Object.hasOwn 으로 막아 둔 그 길이다.
  assert.deepEqual(calls.record, [{ userId: USER, keys: [KEY] }]);
});

// ───────────────────────────────────────────────── 다시 보내도 안전하다

test("🔴 `recorded` 는 **표에 새로 생긴 행 수가 아니다** — 보낸 것 중 뜻이 지켜진 수다", async () => {
  // 같은 열쇠를 두 번 실어도 한 번으로 센다. 행 수를 돌려주면 두 번째 요청이
  // `recorded: 0` 을 받고 붙이는 쪽이 「덜 적혔다」고 오해한다.
  const { deps, calls } = makeDeps();
  const result = await handleDismissalRequest(
    post({ authorization: HEADER, keys: [KEY, KEY, KEY] }),
    deps
  );

  assert.equal(result.status, 200);
  // 🔵 중복은 `dropped` 에 세지 않는다 — 보낸 쪽의 잘못이 아니고 뜻은 지켜졌다.
  assert.deepEqual(recordedOf(result.body), { recorded: 1, dropped: 0 });
  assert.deepEqual(calls.record, [{ userId: USER, keys: [KEY] }]);
});

test("같은 요청을 두 번 보내도 답이 같다 — 끊겨서 재시도해도 아무 일이 없다", async () => {
  const { deps, calls } = makeDeps();
  const first = await handleDismissalRequest(post({ authorization: HEADER }), deps);
  const second = await handleDismissalRequest(post({ authorization: HEADER }), deps);

  assert.deepEqual(first.body, second.body);
  assert.equal(second.status, 200);
  assert.equal(calls.record.length, 2, "두 번 다 적으러 간다 — 겹치는 것은 표가 조용히 넘긴다");
});

// ───────────────────────────────────────────────── 응답의 모양

test("성공 응답은 `{ recorded, dropped }` 두 칸뿐이다", async () => {
  const { deps } = makeDeps();
  const result = await handleDismissalRequest(post({ authorization: HEADER }), deps);

  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body as object).sort(), ["dropped", "recorded"]);
  assert.deepEqual(recordedOf(result.body), { recorded: 1, dropped: 0 });
});

test("🔴 답은 어디에도 남지 않는다 — 성공도 거절도 no-store", async () => {
  const { deps } = makeDeps();
  const ok = await handleDismissalRequest(post({ authorization: HEADER }), deps);
  const noKeys = await handleDismissalRequest(
    post({ authorization: HEADER, body: `sub=${USER}` }),
    deps
  );
  const unauthorized = await handleDismissalRequest(post(), deps);

  for (const [name, result] of [["성공", ok], ["열쇠 없음", noKeys], ["인증 실패", unauthorized]] as const) {
    assert.equal(result.headers["cache-control"], "no-store", name);
    assert.equal(result.headers["pragma"], "no-cache", name);
  }
});

test("🔴 거절의 로그 까닭에 사람도 열쇠도 적히지 않는다", async () => {
  // 열쇠에는 수리 건 번호 같은 업무 식별자가 들어 있다. 로그에 남는 것은
  // 까닭 하나뿐이어야 한다.
  const { deps } = makeDeps();
  const tooMany = Array.from({ length: MAX_DISMISSAL_KEYS_PER_REQUEST + 1 }, (_, i) => `rf-service-system:${i}`);
  for (const result of [
    await handleDismissalRequest(post({ authorization: HEADER, body: `sub=${USER}` }), deps),
    await handleDismissalRequest(post({ authorization: HEADER, keys: tooMany }), deps),
    await handleDismissalRequest(post({ keys: [KEY] }), deps),
  ]) {
    assert.equal(typeof result.logReason, "string");
    assert.doesNotMatch(String(result.logReason), new RegExp(USER));
    assert.doesNotMatch(String(result.logReason), /RC-2026-0001/);
  }
});

// ───────────────────────────────────────────────── 실패 한도

test("인증 실패가 잦으면 429 로 바뀐다 — 읽기 통로와 같은 통을 쓴다", async () => {
  const { deps } = makeDeps({ limited: true });
  const result = await handleDismissalRequest(post(), deps);

  assert.equal(result.status, 429);
  assert.equal(result.headers["retry-after"], "7");
  assert.match(descriptionOf(result.body), /client_secret/);
});

test("한도는 **실패만** 센다 — 정상 지움은 몇 번을 보내도 세지 않는다", async () => {
  const { deps, calls } = makeDeps({ limited: true });
  for (let i = 0; i < 5; i += 1) {
    const result = await handleDismissalRequest(post({ authorization: HEADER }), deps);
    assert.equal(result.status, 200);
  }
  assert.equal(calls.authFailures, 0);
});

test("한도를 안 걸어도(시험·초기 설정) 판정은 그대로다", async () => {
  const { deps } = makeDeps();
  delete deps.countAuthFailure;
  const result = await handleDismissalRequest(post(), deps);
  assert.equal(result.status, 401);
});
