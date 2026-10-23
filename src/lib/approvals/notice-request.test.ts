import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleApprovalCreatedRequest,
  MAX_APPROVERS_PER_REQUEST,
  type ApprovalCreatedDeps,
} from "./notice-request";

/**
 * ============================================================================
 * 이 통로에서 지켜야 하는 것 넷
 * ============================================================================
 *  ① **거절이 제대로 되는가** — 이 방향(사이트 → 포털)의 통로가 늘 때마다 늘
 *     같은 물음이다. 자격증명이 틀린 쪽이 남의 메일을 띄우게 할 수 없어야 한다.
 *  ② **모르는 사람 번호로는 아무 일도 안 일어나는가** — 저쪽이 보내 오는 것은
 *     사람 번호뿐이고, 그 값은 저쪽이 지어낼 수 있다.
 *  ③ 🔴 **기다리지 않는가** — 사람이 [신청] 단추를 누르고 서 있는 자리다.
 *     메일이 응답을 붙들면 그 단추가 2초 뒤에 실패로 보인다.
 *  ④ 🔴 **떼어 낸 일이 던져도 안 죽는가** — 응답이 나간 뒤라 받아 줄 사람이
 *     없고, 잡히지 않은 거절은 **일곱 사이트의 로그인을 떠받치는** 포털
 *     프로세스를 죽일 수 있다.
 * ============================================================================
 */

const URL_BASE = "https://portal.example/api/integration/approval-created";
const CLIENT = { clientId: "rf-service-system" };

/** 🔴 가짜 번호다. 실제 계정의 값을 적지 않는다. */
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

function basic(clientId: string, clientSecret: string): string {
  const raw = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

function post(options: { authorization?: string; body?: string; url?: string } = {}): Request {
  return new Request(options.url ?? URL_BASE, {
    method: "POST",
    headers: options.authorization ? { authorization: options.authorization } : {},
    body: options.body ?? `approverSub=${ALICE}`,
  });
}

const OK_AUTH = basic("rf-service-system", "맞는값");

type Calls = {
  findActiveClient: string[];
  findUser: string[];
  hasAccess: string[];
  notified: string[];
  authFailures: number;
  /** 🔴 맡겨진 일감들. **돌리지 않고 들고만 있는다** — 그래야 ③ 을 잴 수 있다. */
  scheduled: (() => Promise<void>)[];
};

function makeDeps(
  over: {
    client?: { clientId: string } | null;
    secretOk?: boolean;
    user?: { status: string } | null;
    access?: boolean;
    limited?: boolean;
    /** 맡긴 일이 던지는 경우(④). */
    notifyThrows?: boolean;
  } = {}
): { deps: ApprovalCreatedDeps<{ clientId: string }>; calls: Calls } {
  const calls: Calls = {
    findActiveClient: [],
    findUser: [],
    hasAccess: [],
    notified: [],
    authFailures: 0,
    scheduled: [],
  };

  const deps: ApprovalCreatedDeps<{ clientId: string }> = {
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
    async notify({ userId }) {
      calls.notified.push(userId);
      if (over.notifyThrows) throw new Error("메일 서버가 죽었다");
    },
    schedule(task) {
      calls.scheduled.push(task);
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

function countsOf(body: unknown): { accepted: number; skipped: number; dropped: number } {
  return body as { accepted: number; skipped: number; dropped: number };
}

// ───────────────────────────────────────────── ① 거절

test("🔴 인증 없이 부르면 거절한다 — DB 도 메일도 건드리지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalCreatedRequest(post(), deps);

  assert.equal(result.status, 401);
  assert.equal(errorOf(result.body), "invalid_client");
  assert.equal(result.headers["www-authenticate"], 'Basic realm="dss-auth"');
  assert.deepEqual(calls.findActiveClient, []);
  assert.deepEqual(calls.scheduled, []);
  assert.deepEqual(calls.notified, []);
});

test("🔴 시크릿이 틀리면 거절한다 — 남의 메일을 띄우지 못한다", async () => {
  const { deps, calls } = makeDeps({ secretOk: false });
  const result = await handleApprovalCreatedRequest(
    post({ authorization: basic("rf-service-system", "틀린값") }),
    deps
  );

  assert.equal(result.status, 401);
  assert.deepEqual(calls.scheduled, []);
  assert.deepEqual(calls.notified, []);
  // 실패를 셌어야 한다 — 시크릿을 두드려 보는 반복을 막는 자리다.
  assert.equal(calls.authFailures, 1);
});

test("없는 client_id 와 틀린 시크릿은 **같은 얼굴**이다", async () => {
  const unknown = makeDeps({ client: null });
  const badSecret = makeDeps({ secretOk: false });

  const a = await handleApprovalCreatedRequest(
    post({ authorization: basic("없는시스템", "아무값") }),
    unknown.deps
  );
  const b = await handleApprovalCreatedRequest(
    post({ authorization: basic("rf-service-system", "틀린값") }),
    badSecret.deps
  );

  assert.equal(a.status, b.status);
  assert.deepEqual(a.body, b.body);
});

test("🔴 비밀값이 쿼리에 실려 오면 거절한다 — 조회조차 하지 않는다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalCreatedRequest(
    post({ authorization: OK_AUTH, url: `${URL_BASE}?client_secret=샌값` }),
    deps
  );

  assert.equal(result.status, 400);
  assert.equal(errorOf(result.body), "invalid_request");
  assert.deepEqual(calls.findActiveClient, []);
  assert.match(String((result.body as { error_description: string }).error_description), /발급/);
});

test("인증 실패가 잦으면 429 로 바뀐다", async () => {
  const { deps } = makeDeps({ secretOk: false, limited: true });
  const result = await handleApprovalCreatedRequest(
    post({ authorization: basic("rf-service-system", "틀린값") }),
    deps
  );

  assert.equal(result.status, 429);
  assert.equal(result.headers["retry-after"], "7");
});

test("🔴 본문 검사는 **시스템 확인 뒤**다 — 자격증명 없이 모양을 떠볼 수 없다", async () => {
  // 시크릿도 틀리고 approverSub 도 없다. 🔴 돌아오는 것은 401 이어야 한다 —
  // 400 이 돌아오면 이 통로가 「어떤 칸을 받는가」를 자격증명 없이 알려 주는
  // 도구가 된다(site-dismissals.ts 가 열쇠 검사를 문 여섯 뒤에 둔 그 까닭).
  const { deps } = makeDeps({ secretOk: false });
  const result = await handleApprovalCreatedRequest(
    post({ authorization: basic("rf-service-system", "틀린값"), body: "" }),
    deps
  );

  assert.equal(result.status, 401);
  assert.equal(errorOf(result.body), "invalid_client");
});

test("approverSub 가 없으면 400 — 누구인지 모르는 신호는 받지 않는다", async () => {
  const { deps, calls } = makeDeps();
  for (const body of ["", "approverSub=", "approverSub=%20%20", "sub=" + ALICE]) {
    const result = await handleApprovalCreatedRequest(post({ authorization: OK_AUTH, body }), deps);
    assert.equal(result.status, 400, body);
    assert.equal(errorOf(result.body), "invalid_request", body);
  }
  assert.deepEqual(calls.findUser, []);
  assert.deepEqual(calls.scheduled, []);
});

test("사람이 너무 많으면 통째로 거절하고 **나눠 보내라**고 말한다", async () => {
  const { deps, calls } = makeDeps();
  const body = Array.from({ length: MAX_APPROVERS_PER_REQUEST + 1 }, (_, at) =>
    `approverSub=${at}`
  ).join("&");

  const result = await handleApprovalCreatedRequest(post({ authorization: OK_AUTH, body }), deps);

  assert.equal(result.status, 400);
  assert.match(
    String((result.body as { error_description: string }).error_description),
    /나눠 보내/
  );
  // 🔴 앞의 몇만 받아 주지 않는다 — 조회도 일감도 없다.
  assert.deepEqual(calls.findUser, []);
  assert.deepEqual(calls.scheduled, []);
});

test("터무니없이 긴 번호는 **조회하지 않고** 버리고 센다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalCreatedRequest(
    post({
      authorization: OK_AUTH,
      body: `approverSub=${"가".repeat(200)}&approverSub=${ALICE}`,
    }),
    deps
  );

  assert.equal(result.status, 202);
  assert.deepEqual(countsOf(result.body), { accepted: 1, skipped: 0, dropped: 1 });
  // 긴 값으로는 DB 를 두드리지 않는다.
  assert.deepEqual(calls.findUser, [ALICE]);
});

test("🔴 답은 어디에도 남지 않는다 — 성공도 거절도 no-store", async () => {
  const ok = makeDeps();
  const bad = makeDeps();

  const accepted = await handleApprovalCreatedRequest(post({ authorization: OK_AUTH }), ok.deps);
  const rejected = await handleApprovalCreatedRequest(post(), bad.deps);

  for (const result of [accepted, rejected]) {
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["pragma"], "no-cache");
  }
});

// ───────────────────────────────────────────── ② 모르는 사람 번호

test("🔴 포털에 **없는** 사람 번호로는 아무 일도 안 일어난다", async () => {
  const { deps, calls } = makeDeps({ user: null });
  const result = await handleApprovalCreatedRequest(post({ authorization: OK_AUTH }), deps);

  // 🔵 202 다. 400 으로 가르면 이 통로가 「그 번호가 있는가」를 묻는 조회 도구가
  //    된다 — 읽기 통로가 401·403 을 한 얼굴로 돌려주며 막아 둔 그 조회다.
  assert.equal(result.status, 202);
  assert.deepEqual(countsOf(result.body), { accepted: 0, skipped: 1, dropped: 0 });
  // 🔴 **일감 자체가 없다.** 비어 있는 일감을 맡기면 로그만 쌓인다.
  assert.deepEqual(calls.scheduled, []);
  assert.deepEqual(calls.notified, []);
});

test("🔴 정지된 계정으로도 아무 일이 안 일어난다", async () => {
  for (const status of ["SUSPENDED", "PENDING"]) {
    const { deps, calls } = makeDeps({ user: { status } });
    const result = await handleApprovalCreatedRequest(post({ authorization: OK_AUTH }), deps);

    assert.equal(result.status, 202, status);
    assert.equal(countsOf(result.body).accepted, 0, status);
    assert.deepEqual(calls.notified, [], status);
  }
});

test("🔴 그 시스템을 쓸 수 없는 사람의 결재는 알리지 않는다 — 문 ⑥ 이 그대로 걸린다", async () => {
  const { deps, calls } = makeDeps({ access: false });
  const result = await handleApprovalCreatedRequest(post({ authorization: OK_AUTH }), deps);

  assert.equal(result.status, 202);
  assert.equal(countsOf(result.body).accepted, 0);
  assert.deepEqual(calls.hasAccess, [ALICE], "권한을 묻지도 않았다");
  assert.deepEqual(calls.notified, []);
});

test("없는 사람 · 정지된 사람 · 권한 없는 사람이 **같은 얼굴**이다", async () => {
  const missing = await handleApprovalCreatedRequest(
    post({ authorization: OK_AUTH }),
    makeDeps({ user: null }).deps
  );
  const suspended = await handleApprovalCreatedRequest(
    post({ authorization: OK_AUTH }),
    makeDeps({ user: { status: "SUSPENDED" } }).deps
  );
  const noAccess = await handleApprovalCreatedRequest(
    post({ authorization: OK_AUTH }),
    makeDeps({ access: false }).deps
  );

  assert.deepEqual(missing.body, suspended.body);
  assert.deepEqual(missing.body, noAccess.body);
});

test("막힌 사람이 섞여 있어도 **나머지는 알린다**", async () => {
  const { deps, calls } = makeDeps();
  // ALICE 만 통과시킨다.
  deps.findUser = async (userId) => (userId === ALICE ? { status: "ACTIVE" } : null);

  const result = await handleApprovalCreatedRequest(
    post({ authorization: OK_AUTH, body: `approverSub=${ALICE}&approverSub=${BOB}` }),
    deps
  );

  assert.deepEqual(countsOf(result.body), { accepted: 1, skipped: 1, dropped: 0 });
  assert.equal(calls.scheduled.length, 1);
  await calls.scheduled[0]();
  assert.deepEqual(calls.notified, [ALICE]);
});

test("같은 사람이 거듭 실려 와도 일감은 하나다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalCreatedRequest(
    post({
      authorization: OK_AUTH,
      body: `approverSub=${ALICE}&approverSub=${ALICE}&approverSub=${ALICE}`,
    }),
    deps
  );

  assert.equal(countsOf(result.body).accepted, 1);
  await calls.scheduled[0]();
  assert.deepEqual(calls.notified, [ALICE]);
});

// ───────────────────────────────────────────── ③ 기다리지 않는다

test("🔴 메일 일을 **기다리지 않는다** — 답이 먼저 나간다", async () => {
  const { deps, calls } = makeDeps();

  const result = await handleApprovalCreatedRequest(post({ authorization: OK_AUTH }), deps);

  // 답은 이미 다 지어졌는데
  assert.equal(result.status, 202);
  assert.deepEqual(countsOf(result.body), { accepted: 1, skipped: 0, dropped: 0 });
  // 🔴 메일 일은 **아직 시작도 안 했다.** 이 줄이 이 시험의 전부다 — `schedule`
  //    에 「들고만 있는 가짜」를 끼웠으므로, 여기서 notified 가 차 있다면
  //    판정 함수가 어딘가에서 `await` 로 메일을 기다렸다는 뜻이다.
  assert.deepEqual(calls.notified, []);
  assert.equal(calls.scheduled.length, 1, "일감을 맡기지도 않았다 — 메일이 영영 안 나간다");

  // 맡긴 일을 돌리면 그제야 돈다.
  await calls.scheduled[0]();
  assert.deepEqual(calls.notified, [ALICE]);
});

test("🔴 사람이 여럿이어도 일감은 **한 덩어리**이고 차례대로 돈다", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleApprovalCreatedRequest(
    post({ authorization: OK_AUTH, body: `approverSub=${ALICE}&approverSub=${BOB}` }),
    deps
  );

  assert.equal(countsOf(result.body).accepted, 2);
  // 🔵 사람 수만큼 맡기지 않는다 — 한꺼번에 던지면 사내 시스템 셋에
  //    (사람 수 × 3) 개의 요청이 동시에 꽂힌다.
  assert.equal(calls.scheduled.length, 1);

  await calls.scheduled[0]();
  assert.deepEqual(calls.notified, [ALICE, BOB]);
});

// ───────────────────────────────────────────── ④ 떼어 낸 일이 던져도

test("🔴 떼어 낸 일이 던져도 **그 일감은 거절하지 않는다** — 포털이 안 죽는다", async () => {
  const { deps, calls } = makeDeps({ notifyThrows: true });

  const result = await handleApprovalCreatedRequest(
    post({ authorization: OK_AUTH, body: `approverSub=${ALICE}&approverSub=${BOB}` }),
    deps
  );
  assert.equal(result.status, 202);

  // 🔴 여기서 거절되면 `after` 가 잡지 못하는 거절이 되고, 그것이 프로세스를
  //    죽일 수 있다. `assert.doesNotReject` 가 그 한 줄이다.
  await assert.doesNotReject(calls.scheduled[0]());

  // 🔵 그리고 **한 사람이 깨져도 다음 사람은 돈다.** 둘 다 불렸어야 한다.
  assert.deepEqual(calls.notified, [ALICE, BOB]);
});

test("🔴 통째로 깨진 요청도 답은 지어진다 — 판정 함수는 던지지 않는다", async () => {
  const { deps } = makeDeps();
  // 사람 조회가 통째로 깨진 경우. 🔵 이것은 라우트가 503 으로 받는 유일한 길이라
  //    **던지는 것이 맞다** — 여기서 삼키면 DB 가 죽은 동안 202 를 돌려주고,
  //    저쪽은 「알렸다」고 믿은 채 재시도하지 않는다.
  deps.findUser = async () => {
    throw new Error("DB 가 죽었다");
  };

  await assert.rejects(
    handleApprovalCreatedRequest(post({ authorization: OK_AUTH }), deps),
    /DB 가 죽었다/
  );
});
