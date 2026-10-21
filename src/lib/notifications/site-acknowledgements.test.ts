import assert from "node:assert/strict";
import { test } from "node:test";
import { contentDigest, type AcknowledgementRow } from "./acknowledgements";
import { MAX_DISMISSAL_KEYS_PER_REQUEST } from "./dismissals";
import type { PortalNotificationFeed, PortalNotificationItem } from "./merge";
import {
  handleAcknowledgementRequest,
  type AcknowledgementDeps,
} from "./site-acknowledgements";
import { handleSiteFeedRequest, type SiteFeedDeps, type SiteRequestDeps } from "./site-feed";

/**
 * ============================================================================
 * 확인 쓰기 통로 — **문 여섯이 같아야 하고, 지문은 포털이 지어야 한다**
 * ============================================================================
 * 지움 쓰기 통로에서 뚫리면 알림을 **하루 동안** 숨길 수 있었다(그 뒤 저절로
 * 돌아온다 — 설계안 5절 ③). 확인은 **돌아오지 않는다.** 그래서 이 파일이 못
 * 박는 것이 하나 더 있다:
 *
 *  🔴 **보내온 지문을 쓰지 않는다.** 사이트가 지문을 정할 수 있으면 아무 값이나
 *     넣어 그 알림을 영영 안 보이게 만들 수 있다.
 * ============================================================================
 */

const URL_BASE = "https://portal.example/api/integration/notification-acknowledgements";
const CLIENT = { clientId: "rf-service-system" };
const USER = "11111111-1111-4111-8111-111111111111";

/** 🔵 A/S 의 알림 id 에는 `:` 가 들어 있다(「종류:대상」). 열쇠는 그 앞에 붙는다. */
const KEY = "rf-service-system:REPAIR_CASE_APPROVAL:RC-0000-0000";

const ITEM: PortalNotificationItem = {
  key: KEY,
  sourceId: "rf-service-system",
  sourceName: "A/S",
  id: "REPAIR_CASE_APPROVAL:RC-0000-0000",
  kind: "REPAIR_CASE_APPROVAL",
  kindLabel: "수리 결재",
  subject: "결재 대기 1건",
  detail: "접수 번호 RC-0000-0000",
  href: "http://example.invalid/cases",
};

const FEED: PortalNotificationFeed = {
  items: [ITEM],
  count: 1,
  sources: [{ clientId: "rf-service-system", name: "A/S", ok: true, count: 1 }],
  degraded: false,
};

const EMPTY_FEED: PortalNotificationFeed = {
  items: [],
  count: 0,
  sources: [],
  degraded: false,
};

function basic(clientId: string, clientSecret: string): string {
  const raw = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

function post(
  options: { authorization?: string; body?: string; url?: string; keys?: string[] } = {}
): Request {
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
  feed?: PortalNotificationFeed;
};

type Calls = {
  findActiveClient: string[];
  findUser: string[];
  hasAccess: string[];
  feedFor: string[];
  record: { userId: string; rows: AcknowledgementRow[] }[];
  authFailures: number;
};

function emptyCalls(): Calls {
  return {
    findActiveClient: [],
    findUser: [],
    hasAccess: [],
    feedFor: [],
    record: [],
    authFailures: 0,
  };
}

/** 문 여섯의 재료. 🔴 읽기·지움 통로 시험과 **같은 값**을 주려고 한 곳에 둔다. */
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

function makeDeps(over: Over = {}): {
  deps: AcknowledgementDeps<{ clientId: string }>;
  calls: Calls;
} {
  const calls = emptyCalls();
  const deps: AcknowledgementDeps<{ clientId: string }> = {
    ...gates(over, calls),
    async feedFor(params) {
      calls.feedFor.push(params.userId);
      return over.feed ?? FEED;
    },
    async record(params) {
      calls.record.push({ userId: params.userId, rows: [...params.rows] });
    },
  };
  return { deps, calls };
}

/** 같은 문 여섯을 가진 읽기 통로. 두 통로의 거절을 맞대 보려고 쓴다. */
function makeFeedDeps(over: Over = {}): SiteFeedDeps<{ clientId: string }> {
  return {
    ...gates(over, emptyCalls()),
    async feedFor() {
      return EMPTY_FEED;
    },
  };
}

function errorOf(body: unknown): string {
  return (body as { error?: string }).error ?? "";
}

function descriptionOf(body: unknown): string {
  return String((body as { error_description?: string }).error_description ?? "");
}

function countsOf(body: unknown): { recorded: number; dropped: number; skipped: number } {
  return body as { recorded: number; dropped: number; skipped: number };
}

const HEADER = basic("rf-service-system", "맞는값");

/**
 * 문 여섯이 막는 것들. 🔴 **이 목록이 세 통로의 계약이다** — 하나가 빠지면 그 문이
 * 확인 쪽에서만 열려 있다는 뜻이고, 확인은 **돌아오지 않으므로** 그 구멍은
 * 지움 쪽 구멍보다 비싸다.
 */
const BLOCKED: { name: string; over: Over; options: Parameters<typeof post>[0] }[] = [
  { name: "자격증명이 없다", over: {}, options: {} },
  {
    name: "Bearer 로는 못 들어온다",
    over: {},
    options: { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.x.y" },
  },
  { name: "시크릿이 틀렸다", over: { secretOk: false }, options: { authorization: HEADER } },
  { name: "등록되지 않은 시스템이다", over: { client: null }, options: { authorization: HEADER } },
  { name: "없는(삭제된) 사람이다", over: { user: null }, options: { authorization: HEADER } },
  {
    name: "정지된 사람이다",
    over: { user: { status: "SUSPENDED" } },
    options: { authorization: HEADER },
  },
  {
    name: "승인 대기인 사람이다",
    over: { user: { status: "PENDING" } },
    options: { authorization: HEADER },
  },
  {
    name: "그 시스템에 들어갈 수 없는 사람이다",
    over: { access: false },
    options: { authorization: HEADER },
  },
  { name: "주소에 비밀값이 실려 있다", over: {}, options: { url: `${URL_BASE}?client_secret=샌값` } },
];

// ───────────────────────────────────────────────── 문 여섯

test("🔴 문 여섯이 읽기 통로와 **똑같이** 막는다 — 상태·본문·머리말·로그 까닭이 같다", async () => {
  for (const blocked of BLOCKED) {
    const write = await handleAcknowledgementRequest(post(blocked.options), makeDeps(blocked.over).deps);
    const read = await handleSiteFeedRequest(post(blocked.options), makeFeedDeps(blocked.over));

    assert.equal(write.status, read.status, blocked.name);
    assert.deepEqual(write.body, read.body, blocked.name);
    assert.deepEqual(write.headers, read.headers, blocked.name);
    assert.equal(write.logReason, read.logReason, blocked.name);
  }
});

test("🔴 거절되면 `record` 도 `feedFor` 도 **한 번도** 불리지 않는다", async () => {
  // 확인은 로그아웃해도 안 돌아온다. 거절된 요청이 표에 행을 남기면 그 알림은
  // **영영** 숨는다 — 지움 쪽보다 비싼 구멍이다.
  for (const blocked of BLOCKED) {
    const { deps, calls } = makeDeps(blocked.over);
    const result = await handleAcknowledgementRequest(post(blocked.options), deps);

    assert.notEqual(result.status, 200, blocked.name);
    assert.deepEqual(calls.record, [], blocked.name);
    assert.deepEqual(calls.feedFor, [], blocked.name);
  }
});

test("인증 없이 두드리면 DB 를 건드리지도 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleAcknowledgementRequest(post(), deps);

  assert.equal(result.status, 401);
  assert.equal(result.headers["www-authenticate"], 'Basic realm="dss-auth"');
  assert.deepEqual(calls.findActiveClient, []);
  assert.deepEqual(calls.record, []);
});

test("🔴 인증을 통과하지 못하면 열쇠 검사 결과가 새지 않는다 — 401 이지 400 이 아니다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleAcknowledgementRequest(
    post({ keys: ["접두사없음", "없는시스템:1"] }),
    deps
  );

  assert.equal(result.status, 401);
  assert.equal(errorOf(result.body), "invalid_client");
  assert.deepEqual(calls.record, []);
});

// ───────────────────────────────────────────────── 열쇠

test("확인할 열쇠가 없으면 400 — 그리고 문구가 **확인** 통로의 것이다", async () => {
  const { deps, calls } = makeDeps();
  for (const body of [`sub=${USER}`, `sub=${USER}&keys=`, `sub=${USER}&keys=,,`]) {
    const result = await handleAcknowledgementRequest(post({ authorization: HEADER, body }), deps);
    assert.equal(result.status, 400, body);
    assert.equal(errorOf(result.body), "invalid_request", body);
    // 🔵 「지울 열쇠가 없습니다」가 나오면 붙이는 쪽이 엉뚱한 곳을 고친다.
    assert.match(descriptionOf(result.body), /확인할 열쇠/, body);
  }
  assert.deepEqual(calls.record, []);
});

test(`🔴 상한(${MAX_DISMISSAL_KEYS_PER_REQUEST})을 넘으면 400 이고 **나눠 보내라**고 말해 준다`, async () => {
  const tooMany = Array.from(
    { length: MAX_DISMISSAL_KEYS_PER_REQUEST + 1 },
    (_, i) => `rf-service-system:${i}`
  );
  const { deps, calls } = makeDeps();
  const result = await handleAcknowledgementRequest(
    post({ authorization: HEADER, keys: tooMany }),
    deps
  );

  assert.equal(result.status, 400);
  assert.match(descriptionOf(result.body), new RegExp(String(MAX_DISMISSAL_KEYS_PER_REQUEST)));
  assert.match(descriptionOf(result.body), /나눠/);
  // 🔴 **자르지 않는다.** 앞의 200개만 조용히 받으면 사람은 전부 확인했다고 믿는다.
  assert.deepEqual(calls.record, []);
});

test("🔴 모양이 틀렸거나 모르는 시스템의 열쇠는 버리고 나머지는 적는다", async () => {
  const other: PortalNotificationItem = {
    ...ITEM,
    key: "dss-leave:7",
    sourceId: "dss-leave",
    id: "7",
    subject: "휴가 승인 1건",
    detail: "다음 주 월요일",
  };
  const { deps, calls } = makeDeps({
    feed: { ...FEED, items: [ITEM, other], count: 2 },
  });

  const result = await handleAcknowledgementRequest(
    post({ authorization: HEADER, keys: [KEY, "접두사없음", "dss-po:1", "dss-leave:7"] }),
    deps
  );

  assert.equal(result.status, 200);
  // 🔵 dss-po 는 **제 알림이 없는 시스템**이라 그런 열쇠는 어디서도 만들어지지
  // 않는다 — 모르는 시스템으로 버려진다(dismissals.ts).
  assert.deepEqual(countsOf(result.body), { recorded: 2, dropped: 2, skipped: 0 });
  assert.deepEqual(
    calls.record[0].rows.map((row) => row.notificationKey),
    [KEY, "dss-leave:7"]
  );
});

// ───────────────────────────────────────────────── 🔴 지문은 포털이 짓는다

test("🔴 지문은 **포털 목록의 그 줄**에서 나온다 — 사이트는 열쇠만 보낸다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleAcknowledgementRequest(post({ authorization: HEADER }), deps);

  assert.equal(result.status, 200);
  assert.deepEqual(calls.record, [
    {
      userId: USER,
      rows: [
        { notificationKey: KEY, contentDigest: contentDigest(ITEM.subject, ITEM.detail) },
      ],
    },
  ]);
});

test("🔴 본문에 지문을 실어 보내도 무시된다 — 그 값으로 알림을 영영 숨길 수 없다", async () => {
  // 사이트가 지문을 정할 수 있으면 **아무 값이나 넣어** 그 알림을 영영 안 보이게
  // 만들 수 있다. 이 통로가 받은 권한은 「확인했다」를 전하는 것뿐이다.
  const { deps, calls } = makeDeps();
  const result = await handleAcknowledgementRequest(
    post({
      authorization: HEADER,
      body: `sub=${USER}&keys=${encodeURIComponent(KEY)}&digest=내가정한값&content_digest=내가정한값`,
    }),
    deps
  );

  assert.equal(result.status, 200);
  assert.equal(calls.record[0].rows[0].contentDigest, contentDigest(ITEM.subject, ITEM.detail));
  assert.notEqual(calls.record[0].rows[0].contentDigest, "내가정한값");
});

test("🔴 내용이 바뀌면 적히는 지문도 바뀐다 — 「그 내용에 대한 확인」이다", async () => {
  const before = makeDeps();
  const first = await handleAcknowledgementRequest(post({ authorization: HEADER }), before.deps);

  const changed = { ...ITEM, subject: "결재 대기 4건" };
  const after = makeDeps({ feed: { ...FEED, items: [changed] } });
  const second = await handleAcknowledgementRequest(post({ authorization: HEADER }), after.deps);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(
    before.calls.record[0].rows[0].contentDigest,
    after.calls.record[0].rows[0].contentDigest
  );
});

test("🔴 목록에 없는 열쇠는 `skipped` 이고 **200 이다** — 해소된 뒤 눌렀을 뿐이다", async () => {
  // 400 으로 만들면 「✓ 를 눌렀는데 빨간 알림이 뜬다」가 되고, 사람은 안 눌린 줄
  // 알고 다시 누른다.
  const { deps, calls } = makeDeps({ feed: EMPTY_FEED });
  const result = await handleAcknowledgementRequest(post({ authorization: HEADER }), deps);

  assert.equal(result.status, 200);
  assert.deepEqual(countsOf(result.body), { recorded: 0, dropped: 0, skipped: 1 });
  // 🔴 **적지도 않는다** — 지문을 계산할 재료가 없다. 재료 없이 적으면 그 줄은
  //    내용과 무관하게 영영 숨는다.
  assert.deepEqual(calls.record, [{ userId: USER, rows: [] }]);
});

test("포털 목록은 **부른 사이트를 빼지 않은** 것으로 받는다", async () => {
  // 사람이 ✓ 를 누르는 줄 가운데 상당수가 **그 사이트 자신의 줄**이다. 뺀 목록을
  // 받으면 그 줄들이 언제나 skipped 가 되어 영영 적히지 않는다.
  const { deps, calls } = makeDeps();
  await handleAcknowledgementRequest(post({ authorization: HEADER }), deps);

  assert.deepEqual(calls.feedFor, [USER]);
  // 🔴 부른 사이트(rf-service-system)의 줄이 그대로 적혔다.
  assert.equal(calls.record[0].rows[0].notificationKey, KEY);
});

// ───────────────────────────────────────────────── 다시 보내도 안전하다

test("같은 요청을 두 번 보내도 답이 같다 — 끊겨서 재시도해도 아무 일이 없다", async () => {
  const { deps, calls } = makeDeps();
  const first = await handleAcknowledgementRequest(post({ authorization: HEADER }), deps);
  const second = await handleAcknowledgementRequest(post({ authorization: HEADER }), deps);

  assert.deepEqual(first.body, second.body);
  assert.equal(second.status, 200);
  assert.equal(calls.record.length, 2, "두 번 다 적으러 간다 — 겹치는 것은 표가 덮어쓴다");
  assert.deepEqual(calls.record[0].rows, calls.record[1].rows);
});

test("🔴 같은 열쇠를 두 번 실어도 한 줄만 적는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleAcknowledgementRequest(
    post({ authorization: HEADER, keys: [KEY, KEY, KEY] }),
    deps
  );

  assert.equal(result.status, 200);
  // 🔵 중복은 `dropped` 에 세지 않는다 — 보낸 쪽의 잘못이 아니고 뜻은 지켜졌다.
  assert.deepEqual(countsOf(result.body), { recorded: 1, dropped: 0, skipped: 0 });
  assert.equal(calls.record[0].rows.length, 1);
});

// ───────────────────────────────────────────────── 응답의 모양

test("성공 응답은 `{ recorded, dropped, skipped }` 세 칸뿐이다", async () => {
  const { deps } = makeDeps();
  const result = await handleAcknowledgementRequest(post({ authorization: HEADER }), deps);

  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body as object).sort(), ["dropped", "recorded", "skipped"]);
});

test("🔴 답은 어디에도 남지 않는다 — 성공도 거절도 no-store", async () => {
  const { deps } = makeDeps();
  const ok = await handleAcknowledgementRequest(post({ authorization: HEADER }), deps);
  const noKeys = await handleAcknowledgementRequest(
    post({ authorization: HEADER, body: `sub=${USER}` }),
    deps
  );
  const unauthorized = await handleAcknowledgementRequest(post(), deps);

  for (const [name, result] of [
    ["성공", ok],
    ["열쇠 없음", noKeys],
    ["인증 실패", unauthorized],
  ] as const) {
    assert.equal(result.headers["cache-control"], "no-store", name);
    assert.equal(result.headers["pragma"], "no-cache", name);
  }
});

test("🔴 거절의 로그 까닭에 사람도 열쇠도 적히지 않는다", async () => {
  const { deps } = makeDeps();
  const tooMany = Array.from(
    { length: MAX_DISMISSAL_KEYS_PER_REQUEST + 1 },
    (_, i) => `rf-service-system:${i}`
  );
  for (const result of [
    await handleAcknowledgementRequest(post({ authorization: HEADER, body: `sub=${USER}` }), deps),
    await handleAcknowledgementRequest(post({ authorization: HEADER, keys: tooMany }), deps),
    await handleAcknowledgementRequest(post({ keys: [KEY] }), deps),
  ]) {
    assert.equal(typeof result.logReason, "string");
    assert.doesNotMatch(String(result.logReason), new RegExp(USER));
    assert.doesNotMatch(String(result.logReason), /RC-0000-0000/);
  }
});

// ───────────────────────────────────────────────── 실패 한도

test("인증 실패가 잦으면 429 로 바뀐다 — 다른 두 통로와 같은 통을 쓴다", async () => {
  const { deps } = makeDeps({ limited: true });
  const result = await handleAcknowledgementRequest(post(), deps);

  assert.equal(result.status, 429);
  assert.equal(result.headers["retry-after"], "7");
  assert.match(descriptionOf(result.body), /client_secret/);
});

test("한도는 **실패만** 센다 — 정상 확인은 몇 번을 보내도 세지 않는다", async () => {
  const { deps, calls } = makeDeps({ limited: true });
  for (let i = 0; i < 5; i += 1) {
    const result = await handleAcknowledgementRequest(post({ authorization: HEADER }), deps);
    assert.equal(result.status, 200);
  }
  assert.equal(calls.authFailures, 0);
});

test("한도를 안 걸어도(시험·초기 설정) 판정은 그대로다", async () => {
  const { deps } = makeDeps();
  delete deps.countAuthFailure;
  const result = await handleAcknowledgementRequest(post(), deps);
  assert.equal(result.status, 401);
});
