import assert from "node:assert/strict";
import { test } from "node:test";
import type { PortalApprovalHistory } from "./history-gather";
import type { ApprovalHistoryPeriod } from "./history-period";
import { handleApprovalHistoryRequest, type ApprovalHistoryDeps } from "./history-request";

/**
 * ============================================================================
 * 이 통로도 **거절이 전부다** — 그리고 기간이 하나 더 붙는다
 * ============================================================================
 * 이 파일이 지키는 것:
 *  · 문 여섯을 **같은 함수로** 지난다(결재함·알림 통로와 한 벌이다).
 *  · 🔴 기간은 **문 여섯 뒤에** 본다 — 자격 없는 쪽이 기간 검사 결과를 보면
 *    이 통로가 「이 글자 모양이 맞나」를 공짜로 물어보는 도구가 된다.
 *  · 🔴 **날짜만 보낸 요청을 포털이 400 으로 돌려준다.** 그대로 세 집에 던지면
 *    셋이 한꺼번에 400 을 내고, 승인함에는 「세 집을 다 못 물었다」만 남아
 *    제 실수를 안 가리킨다.
 *  · 🔴 이 부름은 「승인함을 열었다」로 **치지 않는다** — 결재함 통로와 다른 점이다.
 *
 * 🔵 문 여섯의 속살(머리말 읽기 · 쿼리의 비밀값 · 실패 한도)은 site-feed.test.ts 가
 * 이미 붙들고 있다. 여기서는 **이 통로가 그 문을 지나는가**를 잰다.
 *
 * 🔴 **값은 전부 가짜다.**
 * ============================================================================
 */

const URL_BASE = "https://portal.example/api/integration/approval-history";
const CLIENT = { clientId: "dss-approvals" };
const USER = "11111111-1111-4111-8111-111111111111";
const FROM = "2026-11-01T00:00:00.000Z";
const TO = "2026-12-01T00:00:00.000Z";

/** 🔴 값은 전부 가짜다. */
const HISTORY: PortalApprovalHistory = {
  entries: [
    {
      key: "rf-service-system:REPAIR_CASE:t1",
      sourceId: "rf-service-system",
      sourceName: "A/S 관리",
      id: "REPAIR_CASE:t1",
      subject: "TEST-2026-0001",
      approvalName: "수리 검수 승인",
      decidedAt: "2026-11-03T04:05:06.000Z",
      decision: "APPROVED",
      relation: "SELF",
      counterpartName: null,
      href: "http://as.test:3000/repair-cases/t1",
    },
  ],
  count: 1,
  sources: [
    { clientId: "rf-service-system", name: "A/S 관리", status: "ok", count: 1, dropped: 0 },
    { clientId: "dss-inventory", name: "재고 관리", status: "failed", reason: "http_503" },
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
    body:
      options.body ??
      `sub=${USER}&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
  });
}

type Calls = {
  findActiveClient: string[];
  findUser: string[];
  hasAccess: string[];
  historyFor: { userId: string; period: ApprovalHistoryPeriod }[];
};

function makeDeps(
  over: {
    client?: { clientId: string } | null;
    secretOk?: boolean;
    user?: { status: string } | null;
    access?: boolean;
    historyFails?: boolean;
  } = {}
): { deps: ApprovalHistoryDeps<{ clientId: string }>; calls: Calls } {
  const calls: Calls = { findActiveClient: [], findUser: [], hasAccess: [], historyFor: [] };

  const deps: ApprovalHistoryDeps<{ clientId: string }> = {
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
    async historyFor(params) {
      calls.historyFor.push(params);
      // 🔴 DB 가 죽은 경우다. 라우트가 503 으로 받는다.
      if (over.historyFails) throw new Error("내역을 모으지 못했습니다");
      return HISTORY;
    },
  };

  return { deps, calls };
}

/* ───────────────────────────────── 통과 */

test("🔵 멀쩡한 요청은 200 이고 내역이 그대로 나간다 — 표본이 비어 공짜로 통과하지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalHistoryRequest(
    post({ authorization: basic("dss-approvals", "s3cret") }),
    deps
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, HISTORY);
  assert.equal(calls.historyFor.length, 1);
  assert.equal(calls.historyFor[0].userId, USER);
  assert.equal(calls.historyFor[0].period.from.toISOString(), FROM);
  assert.equal(calls.historyFor[0].period.to.toISOString(), TO);
});

test("🔴 답은 어디에도 남지 않는다 — 기간을 바꿔 다시 물었는데 옛 답이 오면 안 된다", async () => {
  const { deps } = makeDeps();
  const result = await handleApprovalHistoryRequest(
    post({ authorization: basic("dss-approvals", "s3cret") }),
    deps
  );
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers.pragma, "no-cache");
});

test("🔴 본문을 한 번만 읽는다 — 다시 읽으면 기간이 **오류 없이** 언제나 빈다", async () => {
  // `authorizeSiteRequest` 가 읽은 본문을 넘겨받아 쓰는지를 잰다. 다시 읽었다면
  // `sub` 은 멀쩡한데 기간만 없어 400 이 됐을 것이다.
  const { deps, calls } = makeDeps();
  const result = await handleApprovalHistoryRequest(
    post({ authorization: basic("dss-approvals", "s3cret") }),
    deps
  );
  assert.equal(result.status, 200);
  assert.equal(calls.historyFor.length, 1);
});

/* ───────────────────────────────── 기간 */

test("🔴 날짜만 보내면 포털이 400 `invalid_period` 다 — 세 집이 한꺼번에 400 을 내기 전에 막는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalHistoryRequest(
    post({
      authorization: basic("dss-approvals", "s3cret"),
      body: `sub=${USER}&from=2026-11-01&to=2026-12-01`,
    }),
    deps
  );

  assert.equal(result.status, 400);
  assert.deepEqual((result.body as { error: string }).error, "invalid_period");
  // 🔴 묻지도 않았다 — 세 집에 던져 놓고 셋이 거절하게 두면 안 된다.
  assert.equal(calls.historyFor.length, 0);
  // 🔴 무엇을 고쳐야 하는지가 들어 있어야 한다.
  assert.match((result.body as { error_description: string }).error_description, /ISO 8601/);
});

test("🔴 `+09:00` 이 공백으로 풀린 본문도 400 이다 — 인코딩 없이 실으면 이 꼴이 된다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalHistoryRequest(
    post({
      authorization: basic("dss-approvals", "s3cret"),
      body: `sub=${USER}&from=2026-11-01T00:00:00+09:00&to=2026-12-01T00:00:00+09:00`,
    }),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal((result.body as { error: string }).error, "invalid_period");
  assert.equal(calls.historyFor.length, 0);
});

test("기간이 아예 없으면 400 이다 — 조용히 전 기간을 열지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalHistoryRequest(
    post({ authorization: basic("dss-approvals", "s3cret"), body: `sub=${USER}` }),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal(calls.historyFor.length, 0);
});

test("🔵 뒤집힌 기간은 200 이다 — 세 집과 같은 규칙이고, 답은 저쪽이 빈 목록으로 준다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalHistoryRequest(
    post({
      authorization: basic("dss-approvals", "s3cret"),
      body: `sub=${USER}&from=${encodeURIComponent(TO)}&to=${encodeURIComponent(FROM)}`,
    }),
    deps
  );

  assert.equal(result.status, 200);
  assert.equal(calls.historyFor.length, 1);
});

test("🔴 기간은 문 여섯 **뒤**에 본다 — 자격 없는 쪽에 기간 검사 결과를 알려 주면 안 된다", async () => {
  const { deps, calls } = makeDeps();
  // 자격증명이 없고 기간도 틀렸다. 400 이 아니라 **401** 이어야 한다.
  const result = await handleApprovalHistoryRequest(
    post({ body: `sub=${USER}&from=2026-11-01&to=2026-12-01` }),
    deps
  );

  assert.equal(result.status, 401);
  assert.equal(calls.historyFor.length, 0);
});

/* ───────────────────────────────── 문 여섯 */

test("🔴 등록 안 된 시스템은 401 이고, 시크릿이 틀린 것과 **같은 얼굴**이다", async () => {
  const unknown = await handleApprovalHistoryRequest(
    post({ authorization: basic("nobody", "x") }),
    makeDeps({ client: null }).deps
  );
  const badSecret = await handleApprovalHistoryRequest(
    post({ authorization: basic("dss-approvals", "x") }),
    makeDeps({ secretOk: false }).deps
  );

  assert.equal(unknown.status, 401);
  assert.equal(badSecret.status, 401);
  assert.deepEqual(unknown.body, badSecret.body);
});

test("🔴 정지된 사람 · 없는 사람 · 권한 없는 사람이 **같은 얼굴**로 403 이다", async () => {
  const bodies: unknown[] = [];
  for (const over of [{ user: null }, { user: { status: "SUSPENDED" } }, { access: false }]) {
    const { deps, calls } = makeDeps(over);
    const result = await handleApprovalHistoryRequest(
      post({ authorization: basic("dss-approvals", "s3cret") }),
      deps
    );
    assert.equal(result.status, 403);
    // 🔴 거절당한 요청은 세 집에 묻지 않는다.
    assert.equal(calls.historyFor.length, 0);
    bodies.push(result.body);
  }
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[1], bodies[2]);
});

test("🔴 `sub` 이 없으면 400 이고 DB 를 건드리지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalHistoryRequest(
    post({
      authorization: basic("dss-approvals", "s3cret"),
      body: `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
    }),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal(calls.findActiveClient.length, 0);
  assert.equal(calls.historyFor.length, 0);
});

test("🔴 비밀값이 주소에 실려 오면 400 이고 DB 를 건드리지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalHistoryRequest(
    post({
      authorization: basic("dss-approvals", "s3cret"),
      url: `${URL_BASE}?client_secret=leaked`,
    }),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal(calls.findActiveClient.length, 0);
});

test("🔴 거절에도 `no-store` 가 붙는다", async () => {
  const { deps } = makeDeps({ access: false });
  const result = await handleApprovalHistoryRequest(
    post({ authorization: basic("dss-approvals", "s3cret") }),
    deps
  );
  assert.equal(result.headers["cache-control"], "no-store");
});

/* ───────────────────────────────── 결재함 통로와 다른 점 */

test("🔴 「승인함을 열었다」를 적는 일이 이 통로에는 **없다** — 지난달을 뒤적여 점이 꺼지면 안 된다", () => {
  // 🔴 타입에 `markSeen` 이 아예 없다. 있으면 라우트가 끼우게 되고, 끼우는 순간
  //    사람이 내역을 보는 것만으로 `/apps` 타일의 빨간 점이 꺼져 **아직 안 본 새
  //    결재가 묻힌다.** 글자로 못 박아 둔다 — 타입은 시험에서 들여다볼 수 없다.
  const deps = makeDeps().deps as Record<string, unknown>;
  assert.equal("markSeen" in deps, false);
  assert.equal("inboxFor" in deps, false);
  assert.equal(typeof deps.historyFor, "function");
});

test("🔴 모으다 던지면 그대로 올라간다 — 라우트가 503 으로 받는다", async () => {
  const { deps } = makeDeps({ historyFails: true });
  await assert.rejects(
    handleApprovalHistoryRequest(post({ authorization: basic("dss-approvals", "s3cret") }), deps)
  );
});
