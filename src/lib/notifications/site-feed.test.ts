import assert from "node:assert/strict";
import { test } from "node:test";
import type { PortalNotificationFeed } from "./merge";
import {
  handleSiteFeedRequest,
  hasCredentialInQuery,
  readBasicCredentials,
  siteFeedCacheKey,
  type SiteFeedDeps,
} from "./site-feed";

/**
 * ============================================================================
 * 이 통로는 **거절이 전부다**
 * ============================================================================
 * 한 방향이 더 뚫리는 순간(사이트 → 포털) 새로 생기는 것은 「아무 사이트나
 * 아무 사람의 알림을 볼 수 있는 문」의 가능성이다. 아래 시험들은 그 문이
 * 닫혀 있음을 하나씩 못 박는다 — 인증 없이, 시크릿이 틀린 채로, 권한 없는
 * 시스템이, 정지된 계정을, 주소에 비밀값을 싣고.
 * ============================================================================
 */

const URL_BASE = "https://portal.example/api/integration/notifications";
const CLIENT = { clientId: "rf-service-system" };
const USER = "11111111-1111-4111-8111-111111111111";

const FEED: PortalNotificationFeed = {
  items: [
    {
      key: "dss-po:1",
      sourceId: "dss-po",
      sourceName: "DSS PO / 내자",
      id: "1",
      kind: "APPROVAL",
      kindLabel: "결재 대기",
      subject: "PO-1",
      detail: "한 건",
      href: "https://po.example/po/1",
    },
  ],
  count: 1,
  sources: [{ clientId: "dss-po", name: "DSS PO / 내자", ok: true, count: 1 }],
  degraded: false,
};

function basic(clientId: string, clientSecret: string): string {
  const raw = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

function post(options: { authorization?: string; body?: string; url?: string } = {}): Request {
  return new Request(options.url ?? URL_BASE, {
    method: "POST",
    headers: options.authorization ? { authorization: options.authorization } : {},
    body: options.body ?? `sub=${USER}`,
  });
}

type Calls = {
  findActiveClient: string[];
  findUser: string[];
  hasAccess: string[];
  feedFor: { userId: string; exceptClientId: string }[];
  authFailures: number;
};

function makeDeps(
  over: {
    client?: { clientId: string } | null;
    secretOk?: boolean;
    user?: { status: string } | null;
    access?: boolean;
    limited?: boolean;
  } = {}
): { deps: SiteFeedDeps<{ clientId: string }>; calls: Calls } {
  const calls: Calls = {
    findActiveClient: [],
    findUser: [],
    hasAccess: [],
    feedFor: [],
    authFailures: 0,
  };

  const deps: SiteFeedDeps<{ clientId: string }> = {
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
    async feedFor(params) {
      calls.feedFor.push(params);
      return FEED;
    },
    countAuthFailure() {
      calls.authFailures += 1;
      return over.limited
        ? { allowed: false, retryAfterSeconds: 7, firstRejection: true }
        : { allowed: true, retryAfterSeconds: 0, firstRejection: false };
    },
  };

  return { deps, calls };
}

function errorOf(body: unknown): string {
  return (body as { error?: string }).error ?? "";
}

// ───────────────────────────────────────────────── 인증

test("🔴 인증 없이 부르면 거절한다 — DB 를 건드리지도 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleSiteFeedRequest(post(), deps);

  assert.equal(result.status, 401);
  assert.equal(errorOf(result.body), "invalid_client");
  assert.equal(result.headers["www-authenticate"], 'Basic realm="dss-auth"');
  // 머리말 없이 두드리는 요청은 조회 한 번 값도 쓰지 않는다.
  assert.deepEqual(calls.findActiveClient, []);
  assert.deepEqual(calls.feedFor, []);
});

test("🔴 Bearer 토큰으로는 들어올 수 없다 — 이 통로의 자격은 client_secret 하나다", async () => {
  const { deps } = makeDeps();
  const result = await handleSiteFeedRequest(post({ authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.x.y" }), deps);
  assert.equal(result.status, 401);
});

test("머리말이 깨져 있으면 거절한다", async () => {
  const { deps } = makeDeps();
  for (const header of ["Basic", "Basic !!!!", `Basic ${Buffer.from("콜론이없다").toString("base64")}`]) {
    const result = await handleSiteFeedRequest(post({ authorization: header }), deps);
    assert.equal(result.status, 401, header);
  }
});

test("🔴 비밀값이 틀리면 거절한다", async () => {
  const { deps, calls } = makeDeps({ secretOk: false });
  const result = await handleSiteFeedRequest(
    post({ authorization: basic("rf-service-system", "틀린값") }),
    deps
  );

  assert.equal(result.status, 401);
  assert.equal(errorOf(result.body), "invalid_client");
  // 시크릿이 틀리면 그 사람이 누구인지도 보지 않는다.
  assert.deepEqual(calls.findUser, []);
  assert.deepEqual(calls.feedFor, []);
});

test("없는 client_id 와 틀린 시크릿은 **같은 얼굴**이다 — 등록된 시스템 목록을 알려주지 않는다", async () => {
  const unknown = await handleSiteFeedRequest(
    post({ authorization: basic("없는시스템", "s") }),
    makeDeps({ client: null }).deps
  );
  const wrongSecret = await handleSiteFeedRequest(
    post({ authorization: basic("rf-service-system", "s") }),
    makeDeps({ secretOk: false }).deps
  );

  assert.equal(unknown.status, wrongSecret.status);
  assert.deepEqual(unknown.body, wrongSecret.body);
});

// ───────────────────────────────────────────────── 누구의 알림인지

test("🔴 접근 권한이 없는 시스템이 그 사람의 알림을 물으면 거절한다", async () => {
  // 이 시험이 이 조각 전체에서 가장 중요하다. 여기가 뚫리면 등록된 시스템
  // 아무거나가 전 직원의 밀린 일을 세어 볼 수 있다.
  const { deps, calls } = makeDeps({ access: false });
  const result = await handleSiteFeedRequest(
    post({ authorization: basic("rf-service-system", "맞는값") }),
    deps
  );

  assert.equal(result.status, 403);
  assert.equal(errorOf(result.body), "forbidden");
  assert.deepEqual(calls.hasAccess, [USER]);
  assert.deepEqual(calls.feedFor, []);
});

test("🔴 정지된 계정이면 거절한다 — 권한 판정까지 가지도 않는다", async () => {
  const { deps, calls } = makeDeps({ user: { status: "SUSPENDED" } });
  const result = await handleSiteFeedRequest(
    post({ authorization: basic("rf-service-system", "맞는값") }),
    deps
  );

  assert.equal(result.status, 403);
  assert.deepEqual(calls.hasAccess, []);
  assert.deepEqual(calls.feedFor, []);
});

test("승인 대기 계정도 거절한다 — ACTIVE 만 통과한다", async () => {
  const { deps } = makeDeps({ user: { status: "PENDING" } });
  const result = await handleSiteFeedRequest(
    post({ authorization: basic("rf-service-system", "맞는값") }),
    deps
  );
  assert.equal(result.status, 403);
});

test("없는(삭제된) 사람이면 거절한다", async () => {
  const { deps, calls } = makeDeps({ user: null });
  const result = await handleSiteFeedRequest(
    post({ authorization: basic("rf-service-system", "맞는값") }),
    deps
  );

  assert.equal(result.status, 403);
  assert.deepEqual(calls.feedFor, []);
});

test("없는 사람 · 정지된 사람 · 권한 없는 사람이 **같은 얼굴**이다", async () => {
  const header = basic("rf-service-system", "맞는값");
  const missing = await handleSiteFeedRequest(post({ authorization: header }), makeDeps({ user: null }).deps);
  const suspended = await handleSiteFeedRequest(
    post({ authorization: header }),
    makeDeps({ user: { status: "SUSPENDED" } }).deps
  );
  const noAccess = await handleSiteFeedRequest(
    post({ authorization: header }),
    makeDeps({ access: false }).deps
  );

  // 구분해 주면 사이트 하나가 「묻는 것만으로」 포털의 사용자 목록과 각자의
  // 접근 권한을 알아낼 수 있다.
  assert.deepEqual(missing.body, suspended.body);
  assert.deepEqual(missing.body, noAccess.body);
  assert.equal(missing.status, 403);
});

test("sub 가 없으면 400 — 누구인지 모르는 요청은 답하지 않는다", async () => {
  const { deps, calls } = makeDeps();
  for (const body of ["", "sub=", "sub=%20%20", "other=1"]) {
    const result = await handleSiteFeedRequest(
      post({ authorization: basic("rf-service-system", "맞는값"), body }),
      deps
    );
    assert.equal(result.status, 400, body);
    assert.equal(errorOf(result.body), "invalid_request", body);
  }
  assert.deepEqual(calls.findActiveClient, []);
});

test("터무니없이 긴 sub 는 조회하지 않고 거절한다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleSiteFeedRequest(
    post({ authorization: basic("rf-service-system", "맞는값"), body: `sub=${"가".repeat(200)}` }),
    deps
  );

  assert.equal(result.status, 400);
  assert.deepEqual(calls.findUser, []);
});

// ───────────────────────────────────────────────── 비밀값은 주소에 실리지 않는다

test("🔴 비밀값이 쿼리에 실려 오면 거절한다 — 쿼리는 자격증명 통로가 아니다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleSiteFeedRequest(
    post({ url: `${URL_BASE}?client_id=rf-service-system&client_secret=진짜시크릿` }),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal(errorOf(result.body), "invalid_request");
  // 🔴 쿼리에 실린 값으로는 **조회조차 시도하지 않는다.** 여기서 조회가
  // 일어나면 그 순간 쿼리가 두 번째 자격증명 통로가 된다.
  assert.deepEqual(calls.findActiveClient, []);
  assert.deepEqual(calls.feedFor, []);
  // 다시 발급하라는 말이 들어 있어야 한다 — 그 값은 이미 로그에 남았다.
  assert.match(String((result.body as { error_description: string }).error_description), /발급/);
});

test("쿼리에 비밀값이 있으면 머리말이 멀쩡해도 통과시키지 않는다", async () => {
  const { deps } = makeDeps();
  const result = await handleSiteFeedRequest(
    post({
      authorization: basic("rf-service-system", "맞는값"),
      url: `${URL_BASE}?client_secret=샌값`,
    }),
    deps
  );
  assert.equal(result.status, 400);
});

test("비밀값이 아닌 쿼리는 그냥 무시한다", async () => {
  const { deps } = makeDeps();
  const result = await handleSiteFeedRequest(
    post({ authorization: basic("rf-service-system", "맞는값"), url: `${URL_BASE}?trace=1` }),
    deps
  );
  assert.equal(result.status, 200);
});

// ───────────────────────────────────────────────── 통과했을 때

test("정상 요청은 합쳐진 알림을 그대로 내준다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleSiteFeedRequest(
    post({ authorization: basic("rf-service-system", "맞는값") }),
    deps
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, FEED);
  // 조각 3 이 내주는 네 칸 그대로여야 한다 — `@dss/ui` 의 종이 이 모양에
  // 맞춰 만들어졌다.
  assert.deepEqual(Object.keys(result.body as object).sort(), [
    "count",
    "degraded",
    "items",
    "sources",
  ]);
  assert.equal(calls.authFailures, 0, "통과한 요청은 실패 한도를 건드리지 않는다");
});

test("🔴 부른 사이트 자신에게는 묻지 않는다 — 되돌기가 생기지 않는다", async () => {
  const { deps, calls } = makeDeps();
  await handleSiteFeedRequest(post({ authorization: basic("rf-service-system", "맞는값") }), deps);

  assert.deepEqual(calls.feedFor, [{ userId: USER, exceptClientId: "rf-service-system" }]);
});

test("🔴 답은 어디에도 남지 않는다 — 성공도 거절도 no-store", async () => {
  const { deps } = makeDeps();
  const ok = await handleSiteFeedRequest(
    post({ authorization: basic("rf-service-system", "맞는값") }),
    deps
  );
  const denied = await handleSiteFeedRequest(post(), deps);

  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal(denied.headers["cache-control"], "no-store");
});

// ───────────────────────────────────────────────── 실패 한도

test("인증 실패가 잦으면 429 로 바뀐다", async () => {
  const { deps } = makeDeps({ limited: true });
  const result = await handleSiteFeedRequest(post(), deps);

  assert.equal(result.status, 429);
  assert.equal(result.headers["retry-after"], "7");
  // 「시크릿을 확인하라」가 들어 있어야 한다 — 아니면 갑자기 429 가 오는
  // 것으로만 보인다.
  assert.match(String((result.body as { error_description: string }).error_description), /client_secret/);
});

test("한도에 걸린 뒤로는 로그를 한 줄만 남긴다 — 로그가 공격 도구가 되지 않는다", async () => {
  const { deps } = makeDeps({ limited: true });
  const first = await handleSiteFeedRequest(post(), deps);
  assert.equal(typeof first.logReason, "string", "연속 거절의 첫 건은 남긴다");

  // 두 번째부터는 한도가 firstRejection=false 를 돌려주므로 남기지 않는다.
  const { deps: quiet } = makeDeps({ limited: true });
  quiet.countAuthFailure = () => ({ allowed: false, retryAfterSeconds: 3, firstRejection: false });
  const later = await handleSiteFeedRequest(post(), quiet);
  assert.equal(later.status, 429);
  assert.equal(later.logReason, undefined);
});

test("한도는 **실패만** 센다 — 정상 요청은 몇 번을 불러도 세지 않는다", async () => {
  const { deps, calls } = makeDeps({ limited: true });
  for (let i = 0; i < 5; i += 1) {
    const result = await handleSiteFeedRequest(
      post({ authorization: basic("rf-service-system", "맞는값") }),
      deps
    );
    assert.equal(result.status, 200);
  }
  assert.equal(calls.authFailures, 0);
});

test("한도를 안 걸어도(시험·초기 설정) 판정은 그대로다", async () => {
  const { deps } = makeDeps();
  delete deps.countAuthFailure;
  const result = await handleSiteFeedRequest(post(), deps);
  assert.equal(result.status, 401);
});

// ───────────────────────────────────────────────── 머리말 읽기

test("Basic 머리말의 두 조각을 form-urlencode 에서 되돌린다", () => {
  assert.deepEqual(readBasicCredentials(basic("rf-service-system", "가:나 다%라")), {
    clientId: "rf-service-system",
    clientSecret: "가:나 다%라",
  });
});

test("시크릿에 콜론이 있어도 **첫 콜론**에서만 가른다", () => {
  const raw = Buffer.from("id:a:b:c", "utf8").toString("base64");
  assert.deepEqual(readBasicCredentials(`Basic ${raw}`), {
    clientId: "id",
    clientSecret: "a:b:c",
  });
});

test("한쪽이 비어 있으면 자격증명으로 치지 않는다", () => {
  const empty = Buffer.from(":secret", "utf8").toString("base64");
  const noSecret = Buffer.from("id:", "utf8").toString("base64");
  assert.equal(readBasicCredentials(`Basic ${empty}`), null);
  assert.equal(readBasicCredentials(`Basic ${noSecret}`), null);
  assert.equal(readBasicCredentials(null), null);
  assert.equal(readBasicCredentials("Basic"), null);
});

test("비밀값처럼 생긴 쿼리 이름을 전부 잡는다", () => {
  for (const key of ["client_secret", "secret", "client_assertion", "authorization"]) {
    assert.equal(hasCredentialInQuery(`${URL_BASE}?${key}=x`), true, key);
  }
  assert.equal(hasCredentialInQuery(URL_BASE), false);
  assert.equal(hasCredentialInQuery(`${URL_BASE}?sub=x`), false);
});

// ───────────────────────────────────────────────── 캐시 열쇠

test("🔴 캐시가 사람마다 갈린다 — 남의 알림이 보이지 않는다", () => {
  assert.notEqual(siteFeedCacheKey("rf-service-system", "희만"), siteFeedCacheKey("rf-service-system", "영희"));
});

test("🔴 캐시가 부른 사이트마다도 갈린다 — 뺀 시스템이 다르기 때문이다", () => {
  // 여기가 겹치면 A/S 가 받아 간 답(= A/S 것이 빠진 답)이 PO 에게 그대로
  // 나가고, PO 의 종에서 A/S 알림이 통째로 사라진다.
  assert.notEqual(siteFeedCacheKey("rf-service-system", "희만"), siteFeedCacheKey("dss-po", "희만"));
});

test("경계 글자를 넣은 client_id 로 남의 열쇠를 만들 수 없다", () => {
  // "a:b" 라는 이름의 시스템이 사람 "c" 를 물을 때와, "a" 가 "b:c" 를 물을
  // 때가 같은 열쇠가 되면 안 된다.
  assert.notEqual(siteFeedCacheKey("a:b", "c"), siteFeedCacheKey("a", "b:c"));
});
