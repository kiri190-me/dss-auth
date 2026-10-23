import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApprovalInboxRequest, type ApprovalInboxDeps } from "./screen-request";
import type { ScreenApprovalInbox } from "./screen-gather";

/**
 * ============================================================================
 * 이 통로도 **거절이 전부다**
 * ============================================================================
 * 승인함은 `sub` 에 아무나 적어 보낼 수 있다 — 자격은 사이트의 것이지만 「누구의
 * 결재함인가」는 그 사이트가 보내는 값이다. 막는 것은 문 ⑤·⑥ 이고
 * (`authorizeSiteRequest` — notifications/site-feed.ts), 아래 시험들은 이 통로가
 * **같은 문을 지나는지**를 하나씩 못 박는다. 종의 통로와 같은 위험이므로 같은
 * 함수를 쓰는 것이 답이고, 그 사실 자체를 여기서 잰다.
 *
 * 🔵 문 여섯의 속살(머리말 읽기 · 쿼리의 비밀값 · 실패 한도)은 site-feed.test.ts
 * 가 이미 붙들고 있다. 여기서는 **이 통로가 그 문을 지나는가**를 잰다.
 * ============================================================================
 */

const URL_BASE = "https://portal.example/api/integration/approvals";
const CLIENT = { clientId: "dss-approvals" };
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";

/** 🔴 값은 전부 가짜다. */
const INBOX: ScreenApprovalInbox = {
  items: [
    {
      key: "rf-service-system:approval:REPAIR_INSPECTION:t1",
      sourceId: "rf-service-system",
      sourceName: "A/S 관리",
      id: "approval:REPAIR_INSPECTION:t1",
      kind: "REPAIR_INSPECTION",
      kindLabel: "접수건 검수 결재",
      subject: "TEST-2026-0001",
      detail: "",
      requestedAt: "2026-10-21T04:05:06.000Z",
      href: "http://as.test:3000/repair-cases/t1/approval",
    },
  ],
  count: 1,
  sources: [
    { clientId: "rf-service-system", name: "A/S 관리", status: "ok", count: 1 },
    { clientId: "dss-inventory", name: "재고 관리", status: "failed", reason: "http_503" },
    {
      clientId: "dss-leave",
      name: "휴가 관리",
      status: "unavailable",
      reason: "employee_not_linked",
    },
  ],
  degraded: true,
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
  inboxFor: { userId: string }[];
  /** 🔴 「승인함을 열었다」를 적은 기록. `/apps` 의 빨간 점이 이것으로 꺼진다. */
  markSeen: { userId: string; seenAt: Date }[];
  /** 결재함을 모으기 **시작한** 때. 적는 시각이 그보다 뒤면 안 된다. */
  inboxStartedAt: number[];
};

function makeDeps(
  over: {
    client?: { clientId: string } | null;
    secretOk?: boolean;
    user?: { status: string } | null;
    access?: boolean;
    /** 모으는 데 이만큼 걸린다 — 「적는 시각이 모으기 전인가」를 재려고 둔다. */
    inboxDelayMs?: number;
    inboxFails?: boolean;
    markSeenFails?: boolean;
  } = {}
): { deps: ApprovalInboxDeps<{ clientId: string }>; calls: Calls } {
  const calls: Calls = {
    findActiveClient: [],
    findUser: [],
    hasAccess: [],
    inboxFor: [],
    markSeen: [],
    inboxStartedAt: [],
  };

  const deps: ApprovalInboxDeps<{ clientId: string }> = {
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
    async inboxFor(params) {
      calls.inboxStartedAt.push(Date.now());
      calls.inboxFor.push(params);
      if (over.inboxDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, over.inboxDelayMs));
      }
      // 🔴 DB 가 죽은 경우다. 라우트가 503 으로 받는다.
      if (over.inboxFails) throw new Error("결재함을 모으지 못했습니다");
      return INBOX;
    },
    async markSeen(params) {
      calls.markSeen.push(params);
      if (over.markSeenFails) throw new Error("적지 못했습니다");
    },
  };

  return { deps, calls };
}

/** 실패 갈래는 서버 로그에 한 줄 남긴다 — 시험 출력만 조용히 한다. */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

const OK_HEADER = basic("dss-approvals", "맞는값");

function errorOf(body: unknown): string {
  return (body as { error?: string }).error ?? "";
}

// ───────────────────────────────────────────── 자격 없는 사이트는 못 연다

test("🔴 자격증명 없이 부르면 401 — DB 를 건드리지도 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalInboxRequest(post(), deps);

  assert.equal(result.status, 401);
  assert.equal(errorOf(result.body), "invalid_client");
  assert.equal(result.headers["www-authenticate"], 'Basic realm="dss-auth"');
  assert.deepEqual(calls.findActiveClient, []);
  assert.deepEqual(calls.inboxFor, [], "결재함을 모으지 않는다");
});

test("🔴 시크릿이 틀리면 401 — 그 사람이 누구인지도 보지 않는다", async () => {
  const { deps, calls } = makeDeps({ secretOk: false });
  const result = await handleApprovalInboxRequest(
    post({ authorization: basic("dss-approvals", "틀린값") }),
    deps
  );

  assert.equal(result.status, 401);
  assert.deepEqual(calls.findUser, []);
  assert.deepEqual(calls.inboxFor, []);
});

test("등록되지 않은 사이트와 시크릿이 틀린 사이트는 **같은 얼굴**이다", async () => {
  const unknown = await handleApprovalInboxRequest(
    post({ authorization: basic("없는시스템", "s") }),
    makeDeps({ client: null }).deps
  );
  const wrongSecret = await handleApprovalInboxRequest(
    post({ authorization: basic("dss-approvals", "s") }),
    makeDeps({ secretOk: false }).deps
  );

  assert.equal(unknown.status, wrongSecret.status);
  assert.deepEqual(unknown.body, wrongSecret.body);
});

test("Bearer 토큰으로는 들어올 수 없다 — 이 통로의 자격은 client_secret 하나다", async () => {
  const { deps } = makeDeps();
  const result = await handleApprovalInboxRequest(
    post({ authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.x.y" }),
    deps
  );
  assert.equal(result.status, 401);
});

// ───────────────────────────────── 🔴 `sub` 로 남의 결재함을 못 본다

test("🔴 그 시스템에 들어갈 수 없는 사람의 결재함은 내주지 않는다", async () => {
  // 이 시험이 이 파일에서 가장 중요하다. 여기가 뚫리면 등록된 사이트 아무거나가
  // 전 직원의 밀린 결재를 **내용까지** 읽을 수 있다(열 칸에는 제목과 주소가 있다).
  const { deps, calls } = makeDeps({ access: false });
  const result = await handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps);

  assert.equal(result.status, 403);
  assert.equal(errorOf(result.body), "forbidden");
  assert.deepEqual(calls.hasAccess, [USER]);
  assert.deepEqual(calls.inboxFor, []);
});

test("🔴 정지된 계정이면 403 — 권한 판정까지 가지도 않는다", async () => {
  const { deps, calls } = makeDeps({ user: { status: "SUSPENDED" } });
  const result = await handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps);

  assert.equal(result.status, 403);
  assert.deepEqual(calls.hasAccess, []);
  assert.deepEqual(calls.inboxFor, []);
});

test("승인 대기 계정도, 없는(삭제된) 사람도 403 이다 — ACTIVE 만 통과한다", async () => {
  for (const user of [{ status: "PENDING" }, null]) {
    const { deps, calls } = makeDeps({ user });
    const result = await handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps);
    assert.equal(result.status, 403);
    assert.deepEqual(calls.inboxFor, []);
  }
});

test("없는 사람 · 정지된 사람 · 권한 없는 사람이 **같은 얼굴**이다", async () => {
  // 구분해 주면 사이트 하나가 「묻는 것만으로」 포털의 사용자 목록과 각자의
  // 접근 권한을 알아낼 수 있다.
  const missing = await handleApprovalInboxRequest(
    post({ authorization: OK_HEADER }),
    makeDeps({ user: null }).deps
  );
  const suspended = await handleApprovalInboxRequest(
    post({ authorization: OK_HEADER }),
    makeDeps({ user: { status: "SUSPENDED" } }).deps
  );
  const noAccess = await handleApprovalInboxRequest(
    post({ authorization: OK_HEADER }),
    makeDeps({ access: false }).deps
  );

  assert.deepEqual(missing.body, suspended.body);
  assert.deepEqual(missing.body, noAccess.body);
  assert.equal(missing.status, 403);
});

test("🔴 `sub` 에 적힌 사람으로만 모은다 — 바꿔 적어도 그 사람의 문 둘을 다시 지난다", async () => {
  const { deps, calls } = makeDeps();
  await handleApprovalInboxRequest(
    post({ authorization: OK_HEADER, body: `sub=${OTHER_USER}` }),
    deps
  );

  // 🔴 사이트가 적어 보낸 사람 그대로 ⑤(쓸 수 있는가)·⑥(들어갈 수 있는가)을
  //    지나고, 모으는 쪽도 그 사람으로 불린다. 두 판정과 모으기가 **다른 사람**을
  //    보면 그 순간 남의 결재가 새어 나간다.
  assert.deepEqual(calls.findUser, [OTHER_USER]);
  assert.deepEqual(calls.hasAccess, [OTHER_USER]);
  assert.deepEqual(calls.inboxFor, [{ userId: OTHER_USER }]);
});

test("sub 가 없으면 400 — 누구인지 모르는 요청은 답하지 않는다", async () => {
  const { deps, calls } = makeDeps();
  for (const body of ["", "sub=", "sub=%20%20", "other=1"]) {
    const result = await handleApprovalInboxRequest(
      post({ authorization: OK_HEADER, body }),
      deps
    );
    assert.equal(result.status, 400, body);
    assert.equal(errorOf(result.body), "invalid_request", body);
  }
  assert.deepEqual(calls.findActiveClient, [], "DB 를 건드리기 전에 걸린다");
});

test("🔴 비밀값이 주소에 실려 오면 400 — 조회조차 하지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalInboxRequest(
    post({ authorization: OK_HEADER, url: `${URL_BASE}?client_secret=샌값` }),
    deps
  );

  assert.equal(result.status, 400);
  assert.deepEqual(calls.findActiveClient, []);
  assert.deepEqual(calls.inboxFor, []);
  assert.match(String((result.body as { error_description: string }).error_description), /발급/);
});

// ───────────────────────────────────────────── 통과했을 때

test("🔴 통과하면 결재함을 **그대로** 내준다 — 칸 넷이 승인함과의 계약이다", async () => {
  const { deps } = makeDeps();
  const result = await handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps);

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, INBOX);
  assert.deepEqual(Object.keys(result.body as object).sort(), [
    "count",
    "degraded",
    "items",
    "sources",
  ]);
});

test("🔴 `unavailable` 과 `failed` 가 섞이지 않고 그대로 올라간다", async () => {
  const { deps } = makeDeps();
  const result = await handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps);
  const body = result.body as ScreenApprovalInbox;

  assert.equal(body.sources.length, 3, "표본이 비면 아래 단언이 공짜로 통과한다");
  assert.deepEqual(
    body.sources.map((source) => source.status),
    ["ok", "failed", "unavailable"]
  );
  // 🔵 승인함은 이 글자로 「계정이 직원 명단과 연결되지 않았습니다」를 말한다.
  assert.equal(
    body.sources.find((source) => source.status === "unavailable")?.reason,
    "employee_not_linked"
  );
});

test("🔴 답은 어디에도 남지 않는다 — 성공도 거절도 no-store", async () => {
  // 종의 30초 캐시와 다른 점이다. 방금 결재한 건이 승인함에 남아 있으면 안 된다.
  const { deps } = makeDeps();
  const ok = await handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps);
  const denied = await handleApprovalInboxRequest(post(), deps);

  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal(ok.headers["pragma"], "no-cache");
  assert.equal(denied.headers["cache-control"], "no-store");
});

// ──────────────────── 🔴 이 부름이 곧 「승인함을 열었다」다 (`/apps` 의 빨간 점)

test("🔴 승인함을 열면 그 사람의 seen_at 이 갱신된다 — 점은 이것으로 꺼진다", async () => {
  const { deps, calls } = makeDeps();
  const before = Date.now();
  const result = await handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps);
  const after = Date.now();

  assert.equal(result.status, 200);
  assert.equal(calls.markSeen.length, 1, "열었는데 아무것도 안 적었다");
  assert.equal(calls.markSeen[0].userId, USER);
  // 지금 시각으로 민다 — 옛 시각을 적으면 점이 안 꺼지고, 앞선 시각을 적으면
  // 그 뒤에 올 결재까지 「이미 본 것」이 된다.
  const seen = calls.markSeen[0].seenAt.getTime();
  assert.ok(seen >= before && seen <= after, `${seen} 이 ${before}~${after} 밖이다`);
});

test("🔴 적는 시각은 **모으기 전**이다 — 모으는 1.5초 사이의 결재를 묻지 않는다", async () => {
  // 다 모은 뒤의 시각을 적으면, 모으는 동안 올라온 결재가 「이미 본 것」이 되어
  // 점이 영영 안 뜬다 — 화면에는 그 건이 없었는데도 그렇다.
  const { deps, calls } = makeDeps({ inboxDelayMs: 25 });
  await handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps);

  assert.equal(calls.inboxStartedAt.length, 1, "표본이 비면 아래가 공짜로 통과한다");
  assert.ok(
    calls.markSeen[0].seenAt.getTime() <= calls.inboxStartedAt[0],
    "모으기가 시작된 뒤의 시각을 적었다"
  );
});

test("🔴 `sub` 를 바꿔 적어도 **그 사람의** seen_at 만 밀린다", async () => {
  // 여기가 어긋나면 사이트 하나가 남의 점을 꺼 버릴 수 있다 — 그 사람은 새
  // 결재가 온 줄 모른다.
  const { deps, calls } = makeDeps();
  await handleApprovalInboxRequest(
    post({ authorization: OK_HEADER, body: `sub=${OTHER_USER}` }),
    deps
  );

  assert.deepEqual(
    calls.markSeen.map((row) => row.userId),
    [OTHER_USER]
  );
});

test("🔴 거절당한 요청은 seen_at 을 건드리지 않는다 — 문 여섯을 지난 뒤에만 적는다", async () => {
  const denials: { label: string; call: () => Promise<unknown>; calls: Calls }[] = [];

  const noCredential = makeDeps();
  denials.push({
    label: "자격증명 없음(401)",
    call: () => handleApprovalInboxRequest(post(), noCredential.deps),
    calls: noCredential.calls,
  });

  const badSecret = makeDeps({ secretOk: false });
  denials.push({
    label: "시크릿 틀림(401)",
    call: () =>
      handleApprovalInboxRequest(post({ authorization: basic("dss-approvals", "틀린값") }), badSecret.deps),
    calls: badSecret.calls,
  });

  const suspended = makeDeps({ user: { status: "SUSPENDED" } });
  denials.push({
    label: "정지된 계정(403)",
    call: () => handleApprovalInboxRequest(post({ authorization: OK_HEADER }), suspended.deps),
    calls: suspended.calls,
  });

  const noAccess = makeDeps({ access: false });
  denials.push({
    label: "권한 없음(403)",
    call: () => handleApprovalInboxRequest(post({ authorization: OK_HEADER }), noAccess.deps),
    calls: noAccess.calls,
  });

  const noSubject = makeDeps();
  denials.push({
    label: "sub 없음(400)",
    call: () => handleApprovalInboxRequest(post({ authorization: OK_HEADER, body: "" }), noSubject.deps),
    calls: noSubject.calls,
  });

  assert.equal(denials.length, 5, "표본이 비면 아래 단언이 공짜로 통과한다");
  for (const denial of denials) {
    await denial.call();
    assert.deepEqual(denial.calls.markSeen, [], denial.label);
  }
});

test("🔴 모으기가 깨지면(503) seen_at 을 적지 않는다 — 한 줄도 못 본 사람이다", async () => {
  // 못 본 것을 「봤다」로 적으면 점이 거짓으로 꺼지고, 그 새 결재는 묻힌다.
  const { deps, calls } = makeDeps({ inboxFails: true });
  await assert.rejects(() => handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps));

  assert.deepEqual(calls.markSeen, []);
});

test("🔴 적기가 실패해도 결재함은 그대로 내준다 — 점 하나 때문에 화면이 멎으면 안 된다", async () => {
  const { deps, calls } = makeDeps({ markSeenFails: true });
  const result = await quiet(() =>
    handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps)
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, INBOX);
  assert.equal(calls.markSeen.length, 1, "적으려고 시도는 했다");
});

test("🔵 한 시스템을 못 읽은 채(degraded)로도 적는다 — 안 그러면 점이 영영 안 꺼진다", async () => {
  // 위 INBOX 는 재고 관리가 `failed` 인 상태다(degraded: true). 그때도 사람은
  // 나머지 결재를 다 봤고, 안 적으면 그 시스템이 꺼져 있는 동안 승인함을 열고
  // 또 열어도 점이 그대로다.
  const { deps, calls } = makeDeps();
  const result = await handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps);

  assert.equal((result.body as ScreenApprovalInbox).degraded, true, "표본이 degraded 가 아니다");
  assert.equal(calls.markSeen.length, 1);
});

test("🔵 부른 사이트를 빼는 처리가 없다 — 모으는 쪽은 **사람 하나만** 받는다", async () => {
  // 승인함에는 결재 통로가 없어 물어볼 곳 목록에 애초에 들어 있지 않다. 받아
  // 두면 언젠가 그것으로 답이 갈리고, 그때부터 「누가 물었나」가 답을 바꾼다.
  const { deps, calls } = makeDeps();
  await handleApprovalInboxRequest(post({ authorization: OK_HEADER }), deps);

  assert.deepEqual(calls.inboxFor, [{ userId: USER }]);
  assert.deepEqual(Object.keys(calls.inboxFor[0]), ["userId"]);
});
