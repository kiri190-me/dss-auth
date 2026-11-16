import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidatesForActor,
  DELEGATE_CANDIDATE_STATUS,
  handleDelegationRequest,
  MAX_DELEGATION_REASON_LENGTH,
  statusForFailure,
  toWireDelegation,
  type AllDelegationsResult,
  type ApprovalDelegationRow,
  type CreateDelegationCommand,
  type DelegateCandidate,
  type DelegateCandidateList,
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
  /** 🔵 인자가 없는 조회라 **센 횟수**만 남긴다. */
  listCandidates: number;
  create: CreateDelegationCommand[];
  revoke: RevokeDelegationCommand[];
};

function makeDeps(
  over: {
    client?: { clientId: string } | null;
    secretOk?: boolean;
    /**
     * 🔴 **깃발의 기본값은 꺼짐**이다. 안 적은 시험은 「포털 관리자가 아닌 사람」이고,
     * 켜 두면 **이메일을 가리는 길이 시험에서 한 번도 안 걸린다.**
     */
    user?: { status: string; isPortalAdmin?: boolean } | null;
    access?: boolean;
    acting?: ActingApproverSubjects;
    mine?: { given: ApprovalDelegationRow[]; received: ApprovalDelegationRow[] };
    all?: AllDelegationsResult;
    candidates?: DelegateCandidate[];
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
    listCandidates: 0,
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
      if (over.user === null) return null;
      // 🔴 위임 통로는 이 줄에서 **깃발도** 읽는다(이메일을 내릴지가 여기서 갈린다).
      return {
        status: over.user?.status ?? "ACTIVE",
        isPortalAdmin: over.user?.isPortalAdmin ?? false,
      };
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
    async listCandidates() {
      calls.listCandidates += 1;
      return over.candidates ?? [];
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

// ─────────────────────────────────── candidates — 승인함의 고르개

/**
 * 🔴 **셋이다.** 하나로 재면 「전부 가린다」와 「하나만 가린다」가 같은 답이 되고,
 * 이메일이 원래 없는 사람(`null`)이 섞여 있어야 **가려서 null 인지 원래 null 인지**를
 * 따로 물을 수 있다. 값은 전부 가짜다.
 */
const CANDIDATES: DelegateCandidate[] = [
  { sub: ME, name: "홍길동", email: "hong@example.invalid" },
  { sub: OTHER, name: "김철수", email: "kim@example.invalid" },
  { sub: THIRD, name: "박영희", email: null },
];

test("🔴 포털 관리자가 부르면 이메일이 실린다 — 이름이 같은 사람을 갈라야 한다", async () => {
  const { deps, calls } = makeDeps({
    user: { status: "ACTIVE", isPortalAdmin: true },
    candidates: CANDIDATES,
  });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=candidates`), deps);

  assert.equal(result.status, 200);
  const body = result.body as { candidates: DelegateCandidate[]; emailsIncluded: boolean };
  assert.equal(body.candidates.length, 3, "🔵 표본이 비면 아래 단언이 공짜로 통과한다");
  assert.deepEqual(
    body.candidates.map((candidate) => candidate.email),
    ["hong@example.invalid", "kim@example.invalid", null]
  );
  // 🔴 답이 **스스로** 「가리지 않았다」고 말한다. 그래야 위의 세 번째 `null` 을
  //    「이 사람은 이메일이 등록돼 있지 않다」로 읽을 수 있다.
  assert.equal(body.emailsIncluded, true);
  assert.equal(calls.listCandidates, 1);
});

test("🔴 포털 관리자가 **아니면** 이메일이 전부 null — 이름과 sub 는 그대로 온다", async () => {
  // 🔵 깃발을 안 적었다 = 관리자가 아니다(makeDeps 의 기본값).
  const { deps } = makeDeps({ candidates: CANDIDATES });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=candidates`), deps);

  assert.equal(result.status, 200);
  const body = result.body as { candidates: DelegateCandidate[]; emailsIncluded: boolean };
  // 🔴 **고르개는 그대로 돌아간다** — 가리는 것은 이메일 한 칸뿐이다. 목록이 함께
  //    비면 권한 없는 사람은 아무도 고를 수 없게 되고, 그것은 기능이 없는 것과 같다.
  assert.deepEqual(body.candidates, [
    { sub: ME, name: "홍길동", email: null },
    { sub: OTHER, name: "김철수", email: null },
    { sub: THIRD, name: "박영희", email: null },
  ]);
  // 🔴 이쪽의 `null` 은 **「당신에게는 안 보여 준다」**다. 위 시험의 `null` 과 글자는
  //    같고 뜻이 다르며, 그 둘을 가르는 것이 이 깃발 하나뿐이다.
  assert.equal(body.emailsIncluded, false);
});

test("🔴 이메일이 **원래 없는** 사람은 관리자가 불러도 null — 포털에서 그 칸은 빈다", async () => {
  const { deps } = makeDeps({
    user: { status: "ACTIVE", isPortalAdmin: true },
    candidates: [{ sub: THIRD, name: "박영희", email: null }],
  });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=candidates`), deps);

  const body = result.body as { candidates: DelegateCandidate[] };
  assert.equal(body.candidates.length, 1);
  // 🔵 카카오 이메일은 선택 동의라 안 올 수 있다(schema/users.ts). A/S 와 다른
  //    점이고, 받는 쪽은 이 null 을 **정상**으로 그려야 한다.
  assert.equal(body.candidates[0].email, null);
  assert.equal(body.candidates[0].name, "박영희");
});

test("🔴 가리는 판정은 순수 함수 하나다 — 깃발이 꺼졌거나 사람을 모르면 안 싣는다", () => {
  const emails = (list: DelegateCandidateList) =>
    list.candidates.map((candidate) => candidate.email);

  assert.deepEqual(emails(candidatesForActor(CANDIDATES, { isPortalAdmin: true })), [
    "hong@example.invalid",
    "kim@example.invalid",
    null,
  ]);
  assert.deepEqual(emails(candidatesForActor(CANDIDATES, { isPortalAdmin: false })), [
    null,
    null,
    null,
  ]);
  // 🔴 **모르는 사람에게는 닫는다.** 문 ⑤ 가 이미 걸러 실제로는 올 수 없는 값이지만,
  //    기본값이 열린 쪽이면 그 문을 손대는 날 조용히 새어 나간다.
  assert.deepEqual(emails(candidatesForActor(CANDIDATES, null)), [null, null, null]);
  // 🔴 **가린 사실과 깃발이 한 함수에서 함께 나온다.** 따로 지으면 어긋난 날 화면이
  //    틀린 안내를 아주 자신 있게 한다.
  assert.equal(candidatesForActor(CANDIDATES, { isPortalAdmin: true }).emailsIncluded, true);
  assert.equal(candidatesForActor(CANDIDATES, { isPortalAdmin: false }).emailsIncluded, false);
  assert.equal(candidatesForActor(CANDIDATES, null).emailsIncluded, false);
  // 🔵 받은 목록을 **고쳐 쓰지 않는다** — 조회 결과를 캐시에 들고 있는 날 그 캐시가
  //    가려진 채로 남으면, 다음에 관리자가 물어도 이메일이 영영 안 온다.
  assert.equal(CANDIDATES[0].email, "hong@example.invalid");
});

test("🔴 관리자가 불렀는데 **전원의 이메일이 원래 비어** 있어도 깃발은 참이다", async () => {
  const { deps } = makeDeps({
    user: { status: "ACTIVE", isPortalAdmin: true },
    // 🔵 개발 DB 에서 실제로 이랬다 — 다섯 중 넷이 빈 칸이었다(2026-11-16 실측).
    candidates: [
      { sub: ME, name: "홍길동", email: null },
      { sub: OTHER, name: "김철수", email: null },
    ],
  });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=candidates`), deps);

  const body = result.body as { candidates: DelegateCandidate[]; emailsIncluded: boolean };
  assert.equal(body.candidates.length, 2, "🔵 표본이 비면 아래가 공짜로 통과한다");
  assert.deepEqual(
    body.candidates.map((candidate) => candidate.email),
    [null, null]
  );
  // 🔴 **이 조각의 핵심이다.** 깃발을 「실린 이메일을 세어」 정하면 여기서 거짓이 되고,
  //    화면은 **있지도 않은 권한 문제**를 안내한다. 이 칸은 문이 열렸는지를 말하는
  //    것이지 결과를 세는 것이 아니다.
  assert.equal(body.emailsIncluded, true);
});

test("🔴 후보가 **한 명도 없어도** 깃발은 부른 사람 기준이다 — 빈 목록에 거짓이 안 붙는다", async () => {
  const asAdmin = await handleDelegationRequest(
    post(`sub=${ME}&action=candidates`),
    makeDeps({ user: { status: "ACTIVE", isPortalAdmin: true }, candidates: [] }).deps
  );
  const adminBody = asAdmin.body as { candidates: DelegateCandidate[]; emailsIncluded: boolean };
  assert.deepEqual(adminBody.candidates, []);
  assert.equal(adminBody.emailsIncluded, true);

  // 🔵 짝을 함께 둔다. 한쪽만 재면 「언제나 참」도 통과한다.
  const asUser = await handleDelegationRequest(
    post(`sub=${ME}&action=candidates`),
    makeDeps({ candidates: [] }).deps
  );
  const userBody = asUser.body as { candidates: DelegateCandidate[]; emailsIncluded: boolean };
  assert.deepEqual(userBody.candidates, []);
  assert.equal(userBody.emailsIncluded, false);
});

test("🔴 조회가 칸을 더 실어도 나가는 것은 **셋뿐**이다 — 상태도 깃발도 아니다", async () => {
  const leaky = [
    { sub: ME, name: "홍길동", email: "hong@example.invalid", status: "ACTIVE", isPortalAdmin: true },
  ] as unknown as DelegateCandidate[];
  const { deps } = makeDeps({
    user: { status: "ACTIVE", isPortalAdmin: true },
    candidates: leaky,
  });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=candidates`), deps);

  const body = result.body as { candidates: Record<string, unknown>[] };
  // 이 목록은 **사내 전원**이라, 따라 나가는 칸 하나가 곧 전원의 그 값이다.
  assert.deepEqual(Object.keys(body.candidates[0]).sort(), ["email", "name", "sub"]);
});

test("🔴 부른 사람 자신이 목록에서 **안 빠진다** — 거르는 것은 이 통로의 일이 아니다", async () => {
  const { deps } = makeDeps({ candidates: CANDIDATES });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=candidates`), deps);

  const body = result.body as { candidates: DelegateCandidate[] };
  // 🔴 「누구 기준으로 뺄까」가 하나가 아니다 — 포털 관리자는 **남의** 결재권도 맡길
  //    수 있어서, 기준이 되는 사람이 부른 사람과 다르다. 자기에게 맡기는 줄은 create 의
  //    모양 검사와 표의 CHECK 가 막는다(위의 「자기 자신을 대리 결재자로」 시험).
  assert.ok(
    body.candidates.some((candidate) => candidate.sub === ME),
    "부른 사람(sub)이 고르개에서 사라졌다"
  );
});

test("🔴 대리인으로 세울 수 있는 계정 상태는 **ACTIVE 하나**다", () => {
  // 포털의 사람 상태는 셋뿐이다(schema/users.ts).
  const PORTAL_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED"] as const;
  assert.deepEqual(
    PORTAL_STATUSES.filter((status) => status === DELEGATE_CANDIDATE_STATUS),
    ["ACTIVE"]
  );
  // 🔴 거르는 것은 **조회(SQL)** 다 — 이 층은 조회가 준 줄을 그대로 내보낸다. 그래서
  //    여기서 잴 수 있는 것은 「어떤 값으로 거르기로 했나」까지다. 이 값은 쓰기 쪽
  //    (mutations 의 `isUsableUser`)과 같아야 한다: 넓히면 고를 수는 있는데 저장이
  //    거절되고, 좁히면 세울 수 있는 사람이 목록에 없다.
});

test("🔴 고르개의 답도 어디에도 남지 않는다 — 사내 전원의 이름이 실린 목록이다", async () => {
  const { deps } = makeDeps({ candidates: CANDIDATES });
  const result = await handleDelegationRequest(post(`sub=${ME}&action=candidates`), deps);

  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers.pragma, "no-cache");
});

test("🔴 고르개도 문 여섯 뒤다 — 자격증명 없이 사내 명부를 뽑을 수 없다", async () => {
  const { deps, calls } = makeDeps({ candidates: CANDIDATES });
  const result = await handleDelegationRequest(
    new Request(URL_BASE, { method: "POST", body: `sub=${ME}&action=candidates` }),
    deps
  );

  assert.equal(result.status, 401);
  assert.equal(calls.listCandidates, 0, "🔴 명부를 읽지도 않는다");
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
