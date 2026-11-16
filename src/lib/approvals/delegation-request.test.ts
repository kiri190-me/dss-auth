import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleDelegationRequest,
  MAX_DELEGATION_REASON_LENGTH,
  statusForFailure,
  toWireDelegation,
  type AllDelegationsResult,
  type ApprovalDelegationRow,
  type CreateDelegationCommand,
  type DelegationDeps,
  type RevokeDelegationCommand,
} from "./delegation-request";
import type { ActingApproverSubjects, DelegationWriteResult } from "./delegation";

/**
 * ============================================================================
 * 이 통로도 **거절이 전부다** — 그리고 여기는 **쓰기까지** 닿는다
 * ============================================================================
 * 앞의 통로들은 사칭으로 새는 것이 「남의 밀린 일 건수」였다. 여기서는 사칭이
 * **남의 결재권을 맡기는 일**이 될 수 있다. 막는 것은 같은 문 여섯
 * (`authorizeSiteRequest` — notifications/site-feed.ts)과, 그 위에 얹은 울타리
 * 둘이다:
 *
 *   · 남의 결재권을 맡기거나 거두는 것은 **포털 관리자만**
 *   · 🔴 **맡은 위임은 스스로 되돌릴 수 없다**
 *
 * 🔵 문 여섯의 속살(머리말 읽기 · 쿼리의 비밀값 · 실패 한도)은 site-feed.test.ts 가
 * 이미 붙들고 있다. 여기서는 **이 통로가 그 문을 지나는가**와 **네 갈래가 각자 제
 * 일을 하는가**를 잰다.
 * ============================================================================
 */

const URL_BASE = "https://portal.example/api/integration/delegations";
const CLIENT = { clientId: "dss-approvals" };
/** 🔴 값은 전부 가짜다. */
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

const NOW = new Date("2026-11-16T03:00:00.000Z");

function basic(clientId: string, clientSecret: string): string {
  const raw = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

const OK_HEADER = basic("dss-approvals", "맞는값");

function post(body: string, options: { authorization?: string; url?: string } = {}): Request {
  return new Request(options.url ?? URL_BASE, {
    method: "POST",
    headers: { authorization: options.authorization ?? OK_HEADER },
    body,
  });
}

function row(over: Partial<ApprovalDelegationRow> = {}): ApprovalDelegationRow {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    delegatorUserId: ME,
    delegatorName: "홍길동",
    delegateUserId: OTHER,
    delegateName: "김철수",
    startsAt: new Date("2026-11-16T00:00:00.000Z"),
    endsAt: new Date("2026-11-20T00:00:00.000Z"),
    reason: "출장",
    createdByUserId: ME,
    createdByName: "홍길동",
    createdAt: new Date("2026-11-15T09:00:00.000Z"),
    revokedAt: null,
    revokedByUserId: null,
    revokedByName: null,
    ...over,
  };
}

type Calls = {
  findActiveClient: string[];
  findUser: string[];
  hasAccess: string[];
  actingFor: { userId: string; now: Date }[];
  listForUser: { userId: string }[];
  listAll: { actorUserId: string; now: Date }[];
  create: CreateDelegationCommand[];
  revoke: RevokeDelegationCommand[];
};

function makeDeps(
  over: {
    client?: { clientId: string } | null;
    secretOk?: boolean;
    user?: { status: string } | null;
    access?: boolean;
    acting?: ActingApproverSubjects;
    mine?: { given: ApprovalDelegationRow[]; received: ApprovalDelegationRow[] };
    all?: AllDelegationsResult;
    writeResult?: DelegationWriteResult;
  } = {}
): { deps: DelegationDeps<{ clientId: string }>; calls: Calls } {
  const calls: Calls = {
    findActiveClient: [],
    findUser: [],
    hasAccess: [],
    actingFor: [],
    listForUser: [],
    listAll: [],
    create: [],
    revoke: [],
  };

  const deps: DelegationDeps<{ clientId: string }> = {
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
    now: () => NOW,
    async actingFor(params) {
      calls.actingFor.push(params);
      return over.acting ?? [params.userId];
    },
    async listForUser(params) {
      calls.listForUser.push(params);
      return over.mine ?? { given: [], received: [] };
    },
    async listAll(params) {
      calls.listAll.push(params);
      return (
        over.all ?? {
          ok: true,
          view: { live: [], finished: [], finishedTruncated: false, finishedLimit: 50 },
        }
      );
    },
    async create(command) {
      calls.create.push(command);
      return over.writeResult ?? { ok: true, id: "created-id" };
    },
    async revoke(command) {
      calls.revoke.push(command);
      return over.writeResult ?? { ok: true, id: command.delegationId };
    },
  };

  return { deps, calls };
}

function errorOf(body: unknown): string {
  return (body as { error?: string }).error ?? "";
}

function codeOf(body: unknown): string {
  return (body as { code?: string }).code ?? "";
}

function describeOf(body: unknown): string {
  return (body as { error_description?: string }).error_description ?? "";
}

// ───────────────────────────────────────────── 문 여섯을 지나는가

test("🔴 자격증명 없이 부르면 401 — DB 도 쓰기도 건드리지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(
    new Request(URL_BASE, { method: "POST", body: `sub=${ME}&action=acting` }),
    deps
  );

  assert.equal(result.status, 401);
  assert.equal(errorOf(result.body), "invalid_client");
  assert.equal(result.headers["www-authenticate"], 'Basic realm="dss-auth"');
  assert.deepEqual(calls.findActiveClient, []);
  assert.deepEqual(calls.actingFor, []);
});

test("🔴 시크릿이 틀리면 401 — 그 사람이 누구인지도 보지 않는다", async () => {
  const { deps, calls } = makeDeps({ secretOk: false });
  const result = await handleDelegationRequest(
    post(`sub=${ME}&action=acting`, { authorization: basic("dss-approvals", "틀린값") }),
    deps
  );

  assert.equal(result.status, 401);
  assert.deepEqual(calls.findUser, []);
  assert.deepEqual(calls.actingFor, []);
});

test("🔴 정지된 계정은 403 — 위임을 묻지도 쓰지도 못한다", async () => {
  const { deps, calls } = makeDeps({ user: { status: "SUSPENDED" } });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=acting`), deps);

  assert.equal(result.status, 403);
  assert.deepEqual(calls.actingFor, []);
});

test("🔴 그 시스템을 쓸 수 없는 사람은 403 — 문 ⑥ 이 그대로 걸린다", async () => {
  const { deps, calls } = makeDeps({ access: false });
  const result = await handleDelegationRequest(
    post(`sub=${ME}&action=create&delegateSub=${OTHER}&startsAt=2026-11-16T00:00:00Z&endsAt=2026-11-20T00:00:00Z`),
    deps
  );

  assert.equal(result.status, 403);
  assert.deepEqual(calls.create, [], "🔴 쓰기까지 가지 않는다");
});

test("sub 이 없으면 400 — 누구의 위임인지 없이는 아무 일도 하지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(post("action=acting"), deps);

  assert.equal(result.status, 400);
  assert.deepEqual(calls.actingFor, []);
});

// ───────────────────────────────────────────── action 갈래

test("🔴 action 이 없으면 400 — 조용히 무엇 하나를 골라 주지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(post(`sub=${ME}`), deps);

  assert.equal(result.status, 400);
  assert.equal(result.logReason, "no_action");
  assert.deepEqual(calls.actingFor, []);
  assert.deepEqual(calls.listForUser, []);
});

test("🔴 모르는 action 은 400 — 400 글에 받는 갈래가 적혀 있다", async () => {
  const { deps } = makeDeps();
  const result = await handleDelegationRequest(post(`sub=${ME}&action=delete`), deps);

  assert.equal(result.status, 400);
  assert.equal(result.logReason, "unknown_action");
  assert.match(describeOf(result.body), /acting/);
  assert.match(describeOf(result.body), /revoke/);
});

test("🔴 action 검사는 **문 여섯 뒤**다 — 자격 없이 갈래를 떠볼 수 없다", async () => {
  const { deps } = makeDeps();
  const result = await handleDelegationRequest(
    new Request(URL_BASE, { method: "POST", body: `sub=${ME}&action=없는갈래` }),
    deps
  );
  // 400 이 아니라 401 이다. 가르면 이 통로가 「어떤 일을 받는가」를 묻는 도구가 된다.
  assert.equal(result.status, 401);
});

// ───────────────────────────────────────────── acting — 각 시스템이 묻는 것

test("🔴 acting 은 본인을 **맨 앞**에 둔 목록을 돌려준다", async () => {
  const { deps, calls } = makeDeps({ acting: [ME, OTHER] });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=acting`), deps);

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { subs: [ME, OTHER], count: 2 });
  assert.deepEqual(calls.actingFor, [{ userId: ME, now: NOW }]);
});

test("🔴 acting 의 답은 **어디에도 남지 않는다** — 되돌린 위임이 30초 더 살면 안 된다", async () => {
  const { deps } = makeDeps();
  const result = await handleDelegationRequest(post(`sub=${ME}&action=acting`), deps);

  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers.pragma, "no-cache");
});

// ───────────────────────────────────────────── list — 승인함이 보는 것

test("list 는 기본이 내 것이다 — 내가 맡긴 것과 대신하고 있는 것", async () => {
  const { deps, calls } = makeDeps({
    mine: { given: [row()], received: [row({ id: "r1", delegatorUserId: THIRD })] },
  });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=list`), deps);

  assert.equal(result.status, 200);
  const body = result.body as { scope: string; given: unknown[]; received: unknown[] };
  assert.equal(body.scope, "mine");
  assert.equal(body.given.length, 1);
  assert.equal(body.received.length, 1);
  assert.deepEqual(calls.listForUser, [{ userId: ME }]);
  assert.deepEqual(calls.listAll, [], "🔴 남의 줄은 묻지도 않는다");
});

test("🔴 망으로 나가는 한 줄은 `…Sub` 이름에 **ISO 글자**다", async () => {
  const wire = toWireDelegation(row({ revokedAt: new Date("2026-11-17T00:00:00.000Z"), revokedByUserId: THIRD, revokedByName: "박영희" }));

  assert.equal(wire.delegatorSub, ME);
  assert.equal(wire.delegateSub, OTHER);
  assert.equal(wire.createdBySub, ME);
  assert.equal(wire.revokedBySub, THIRD);
  assert.equal(wire.startsAt, "2026-11-16T00:00:00.000Z");
  assert.equal(wire.endsAt, "2026-11-20T00:00:00.000Z");
  assert.equal(wire.revokedAt, "2026-11-17T00:00:00.000Z");
  // 🔵 이름을 싣는 까닭은 승인함이 **알 길이 없기** 때문이다(가진 것은 sub 뿐이다).
  assert.equal(wire.delegatorName, "홍길동");
});

test("되돌리지 않은 줄의 되돌림 칸 셋은 전부 null 이다", () => {
  const wire = toWireDelegation(row());
  assert.equal(wire.revokedAt, null);
  assert.equal(wire.revokedBySub, null);
  assert.equal(wire.revokedByName, null);
});

test("🔴 scope=all 은 **조회가** 거절한다 — 통로는 깃발을 보지 않는다", async () => {
  const { deps, calls } = makeDeps({ all: { ok: false, reason: "FORBIDDEN" } });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=list&scope=all`), deps);

  assert.equal(result.status, 403);
  assert.equal(errorOf(result.body), "forbidden");
  assert.equal(codeOf(result.body), "FORBIDDEN");
  // 🔴 **물어는 봤다.** 통로가 미리 가려 버리면, 이 조회를 부르는 새 자리가 생기는
  //    날 인가가 통째로 빠진다 — 판정은 조회 자신이 해야 한다.
  assert.deepEqual(calls.listAll, [{ actorUserId: ME, now: NOW }]);
});

test("scope=all 이 통과하면 살아 있는 줄과 끝난 줄을 함께 준다", async () => {
  const { deps } = makeDeps({
    all: {
      ok: true,
      view: {
        live: [row()],
        finished: [row({ id: "f1", revokedAt: new Date("2026-11-15T00:00:00.000Z"), revokedByUserId: ME, revokedByName: "홍길동" })],
        finishedTruncated: true,
        finishedLimit: 50,
      },
    },
  });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=list&scope=all`), deps);

  assert.equal(result.status, 200);
  const body = result.body as {
    scope: string;
    live: unknown[];
    finished: unknown[];
    finishedTruncated: boolean;
    finishedLimit: number;
  };
  assert.equal(body.scope, "all");
  assert.equal(body.live.length, 1);
  assert.equal(body.finished.length, 1);
  // 🔵 잘렸다는 사실과 N 을 함께 준다 — 화면이 「최근 N건만」을 글자로 박지 않게.
  assert.equal(body.finishedTruncated, true);
  assert.equal(body.finishedLimit, 50);
});

test("🔴 scope 를 틀리게 적으면 400 — 조용히 내 것으로 떨어뜨리지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(post(`sub=${ME}&action=list&scope=everyone`), deps);

  assert.equal(result.status, 400);
  assert.equal(result.logReason, "unknown_scope");
  // 떨어뜨리면 관리자가 오타를 냈을 때 자기 줄만 보고 「아무도 안 맡겼다」로 읽는다.
  assert.deepEqual(calls.listForUser, []);
  assert.deepEqual(calls.listAll, []);
});

// ───────────────────────────────────────────── create — 지정

const PERIOD = "startsAt=2026-11-16T00:00:00Z&endsAt=2026-11-20T00:00:00Z";

test("🔴 delegatorSub 을 안 보내면 **본인의 결재권**이고, 누른 사람은 sub 이다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(
    post(`sub=${ME}&action=create&delegateSub=${OTHER}&${PERIOD}&reason=%EC%B6%9C%EC%9E%A5`),
    deps
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { id: "created-id" });
  assert.equal(calls.create.length, 1);
  const command = calls.create[0];
  assert.equal(command.actorUserId, ME);
  assert.equal(command.delegatorUserId, ME);
  assert.equal(command.delegateUserId, OTHER);
  assert.equal(command.reason, "출장");
  assert.equal(command.startsAt.toISOString(), "2026-11-16T00:00:00.000Z");
  assert.equal(command.endsAt.toISOString(), "2026-11-20T00:00:00.000Z");
  // 🔵 어느 시스템이 보냈는지가 감사 기록에 남는다. 판정에는 쓰이지 않는다.
  assert.equal(command.clientId, "dss-approvals");
});

test("남의 결재권을 맡기면 delegator 와 actor 가 **갈린다** — 그 구분이 기록에 남는다", async () => {
  const { deps, calls } = makeDeps();
  await handleDelegationRequest(
    post(`sub=${ME}&action=create&delegatorSub=${THIRD}&delegateSub=${OTHER}&${PERIOD}`),
    deps
  );

  assert.equal(calls.create[0].delegatorUserId, THIRD);
  assert.equal(calls.create[0].actorUserId, ME, "🔴 누른 사람은 언제나 sub 이다");
});

test("🔴 자기 자신을 대리 결재자로 지정할 수 없다 — DB 까지 가지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(
    post(`sub=${ME}&action=create&delegateSub=${ME}&${PERIOD}`),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal(codeOf(result.body), "VALIDATION_ERROR");
  assert.deepEqual(calls.create, []);
});

test("🔴 끝이 시작과 **같아도** 거절한다 — 단 한순간도 살아 있지 않은 위임이다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(
    post(
      `sub=${ME}&action=create&delegateSub=${OTHER}&startsAt=2026-11-16T00:00:00Z&endsAt=2026-11-16T00:00:00Z`
    ),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal(codeOf(result.body), "INVALID_TIME_RANGE");
  assert.deepEqual(calls.create, []);
});

test("일시를 읽을 수 없으면 400", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(
    post(`sub=${ME}&action=create&delegateSub=${OTHER}&startsAt=어제&endsAt=2026-11-20T00:00:00Z`),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal(codeOf(result.body), "VALIDATION_ERROR");
  assert.deepEqual(calls.create, []);
});

test("기간을 아예 안 보내면 400 — 기간 없는 위임은 없다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(
    post(`sub=${ME}&action=create&delegateSub=${OTHER}`),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal(result.logReason, "no_period");
  assert.deepEqual(calls.create, []);
});

test("대리 결재자를 안 보내면 400", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(post(`sub=${ME}&action=create&${PERIOD}`), deps);

  assert.equal(result.status, 400);
  assert.equal(result.logReason, "no_delegateSub");
  assert.deepEqual(calls.create, []);
});

test("🔴 사유가 상한을 넘으면 400 — 글자 수를 적어 준다", async () => {
  const { deps, calls } = makeDeps();
  const long = "가".repeat(MAX_DELEGATION_REASON_LENGTH + 1);
  const result = await handleDelegationRequest(
    post(
      `sub=${ME}&action=create&delegateSub=${OTHER}&${PERIOD}&reason=${encodeURIComponent(long)}`
    ),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal(codeOf(result.body), "VALIDATION_ERROR");
  assert.match(describeOf(result.body), new RegExp(String(MAX_DELEGATION_REASON_LENGTH)));
  assert.deepEqual(calls.create, []);
  // 🔵 상한 **안**은 그대로 통과한다. 이 짝이 없으면 「언제나 거절」도 통과한다.
  const ok = await handleDelegationRequest(
    post(
      `sub=${ME}&action=create&delegateSub=${OTHER}&${PERIOD}&reason=${encodeURIComponent(
        "가".repeat(MAX_DELEGATION_REASON_LENGTH)
      )}`
    ),
    makeDeps().deps
  );
  assert.equal(ok.status, 200);
});

test("사유를 안 보내면 **빈 글자**다 — 널이 아니다(표의 칸이 NOT NULL)", async () => {
  const { deps, calls } = makeDeps();
  await handleDelegationRequest(
    post(`sub=${ME}&action=create&delegateSub=${OTHER}&${PERIOD}`),
    deps
  );
  assert.equal(calls.create[0].reason, "");
});

test("🔴 쓰기가 거절하면 그 **코드 그대로** 번호로 옮긴다", async () => {
  const { deps } = makeDeps({
    writeResult: {
      ok: false,
      code: "INVALID_USER",
      message: "대리 결재자로 지정할 수 있는 계정이 아닙니다.",
    },
  });
  const result = await handleDelegationRequest(
    post(`sub=${ME}&action=create&delegateSub=${OTHER}&${PERIOD}`),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal(codeOf(result.body), "INVALID_USER");
  // 🔴 글자가 아니라 코드로 가를 수 있어야 한다 — 글자는 언제든 바뀐다.
  assert.equal(describeOf(result.body), "대리 결재자로 지정할 수 있는 계정이 아닙니다.");
});

// ───────────────────────────────────────────── revoke — 되돌리기

test("되돌리기는 줄 번호를 그대로 돌려준다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(
    post(`sub=${ME}&action=revoke&delegationId=d-1`),
    deps
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { id: "d-1" });
  assert.deepEqual(calls.revoke, [
    { actorUserId: ME, clientId: "dss-approvals", delegationId: "d-1" },
  ]);
});

test("delegationId 가 없으면 400", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleDelegationRequest(post(`sub=${ME}&action=revoke`), deps);

  assert.equal(result.status, 400);
  assert.equal(result.logReason, "no_delegation_id");
  assert.deepEqual(calls.revoke, []);
});

test("🔴 **맡은 위임을 스스로 되돌리려 하면 403** — 화면이 아니라 서버가 막는다", async () => {
  const { deps } = makeDeps({
    writeResult: {
      ok: false,
      code: "DELEGATE_CANNOT_REVOKE",
      message: "맡은 결재권은 스스로 되돌릴 수 없습니다. 맡긴 분 또는 포털 관리자에게 요청하세요.",
    },
  });
  const result = await handleDelegationRequest(
    post(`sub=${OTHER}&action=revoke&delegationId=d-1`),
    deps
  );

  assert.equal(result.status, 403);
  assert.equal(errorOf(result.body), "forbidden");
  assert.equal(codeOf(result.body), "DELEGATE_CANNOT_REVOKE");
  // 🔴 「누구에게 말해야 하는가」가 글에 남아 있어야 한다.
  assert.match(describeOf(result.body), /맡긴 분 또는 포털 관리자/);
});

test("없는 줄은 404, 이미 철회된 줄은 409", async () => {
  const notFound = await handleDelegationRequest(
    post(`sub=${ME}&action=revoke&delegationId=d-1`),
    makeDeps({
      writeResult: { ok: false, code: "NOT_FOUND", message: "해당 위임을 찾을 수 없습니다." },
    }).deps
  );
  assert.equal(notFound.status, 404);
  assert.equal(errorOf(notFound.body), "not_found");

  const conflict = await handleDelegationRequest(
    post(`sub=${ME}&action=revoke&delegationId=d-1`),
    makeDeps({
      writeResult: { ok: false, code: "CONFLICT", message: "이미 철회된 위임입니다." },
    }).deps
  );
  assert.equal(conflict.status, 409);
  assert.equal(errorOf(conflict.body), "conflict");
});

// ───────────────────────────────────────────── 거절 번호의 짝

test("🔴 거절 코드와 응답 번호의 짝을 한 자리에 못 박는다", () => {
  assert.equal(statusForFailure("VALIDATION_ERROR"), 400);
  assert.equal(statusForFailure("INVALID_TIME_RANGE"), 400);
  // 🔴 없는 사람과 정지된 사람은 **같은 400** 이다. 갈라 주면 이 통로가 포털 사용자
  //    목록을 묻는 조회 도구가 된다.
  assert.equal(statusForFailure("INVALID_USER"), 400);
  assert.equal(statusForFailure("FORBIDDEN"), 403);
  assert.equal(statusForFailure("DELEGATE_CANNOT_REVOKE"), 403);
  assert.equal(statusForFailure("NOT_FOUND"), 404);
  assert.equal(statusForFailure("CONFLICT"), 409);
  assert.equal(statusForFailure("DELEGATION_EXPIRED"), 409);
});

test("🔴 네 갈래 **전부** 어디에도 남지 않는다", async () => {
  const bodies = [
    `sub=${ME}&action=acting`,
    `sub=${ME}&action=list`,
    `sub=${ME}&action=create&delegateSub=${OTHER}&${PERIOD}`,
    `sub=${ME}&action=revoke&delegationId=d-1`,
  ];
  for (const body of bodies) {
    const result = await handleDelegationRequest(post(body), makeDeps().deps);
    assert.equal(result.status, 200, body);
    assert.equal(result.headers["cache-control"], "no-store", body);
  }
});
