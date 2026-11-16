import assert from "node:assert/strict";
import { test } from "node:test";
import { PORTAL_SERVICE_TOKEN_PURPOSES } from "@/lib/oidc/service-token";
import {
  describeDelegationPushFailure,
  failedDelegationPushes,
  propagateDelegation,
  propagateThenStore,
  readDelegationPushOutcome,
  summarizeDelegationPush,
  toDelegationPushBody,
  type DelegationPropagationResult,
  type DelegationPushCommand,
  type DelegationPushPlan,
  type SignDelegationToken,
} from "./delegation-push";

/**
 * 결재권 위임을 세 시스템에 써 주기.
 *
 * 🔴 이 파일이 지키는 것 다섯:
 *  1. **셋이 다 성공해야 저장한다** — 하나라도 실패하면 `store` 가 **한 번도 안 불린다**
 *     (설계 B-13). 이 조각의 전부가 그 한 줄이다.
 *  2. `not_applicable` 은 **성공이다**. 실패로 읽으면 「그 시스템에 계정이 없는 사람에게는
 *     위임을 아예 못 맡기는」 일이 된다.
 *  3. 🔴 `upsert` 에 **`revokedAt` 을 싣지 않는다.** 실으면 받는 쪽이 그대로 적어서
 *     **갓 맡긴 위임이 철회된 채로** 저장된다 — 포털에는 살아 있어 아무도 못 알아챈다.
 *  4. 시각에 **오프셋이 붙는다.** 없으면 받는 쪽이 400 이고, 받아 적히면 KST/UTC 사이에서
 *     아홉 시간 어긋난다.
 *  5. 쓰임새가 **`dss.delegations.write`** 다. 다르면 세 곳에서 전부 401.
 */

const AS = {
  clientId: "rf-service-system",
  name: "A/S 관리",
  delegationsUrl: "http://as.test/api/integration/delegations",
};
const INVENTORY = {
  clientId: "dss-inventory",
  name: "재고 관리",
  delegationsUrl: "http://inv.test/api/integration/delegations",
};
const LEAVE = {
  clientId: "dss-leave",
  name: "휴가 관리",
  delegationsUrl: "http://leave.test/api/integration/delegations",
};

const ALL_THREE: DelegationPushPlan = { targets: [AS, INVENTORY, LEAVE], unreachable: [] };

const ID = "11111111-2222-4333-8444-555555555555";
const DELEGATOR = "8f0b3a1e-0000-4000-8000-000000000001";
const DELEGATE = "8f0b3a1e-0000-4000-8000-000000000002";

/** 지정 한 번. 🔵 시각은 **KST 로 적는다** — 오프셋이 제대로 실려 나가는지 보려고. */
const UPSERT: DelegationPushCommand = {
  action: "upsert",
  id: ID,
  delegatorSub: DELEGATOR,
  delegateSub: DELEGATE,
  startsAt: new Date("2026-11-17T00:00:00+09:00"),
  endsAt: new Date("2026-11-21T00:00:00+09:00"),
  reason: "출장",
};

const REVOKE: DelegationPushCommand = {
  action: "revoke",
  id: ID,
  revokedAt: new Date("2026-11-18T13:30:00+09:00"),
};

/** 시험을 짧게 두려고 상한을 줄인다. 실제 값은 DELEGATION_PUSH_TIMEOUT_MS. */
const SHORT_TIMEOUT_MS = 60;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const stored = () => json({ outcome: "stored" });

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function recorder(handler: (url: string) => Promise<Response>) {
  const calls: Call[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "{}";
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(raw) });
    return handler(String(input));
  }) as typeof fetch;
  return { impl, calls };
}

/** 🔴 신호를 듣는 가짜. 안 들으면 상한 시험이 영영 안 끝난다(gather.test.ts 의 그 함정). */
function neverAnswers(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    );
  });
}

/** 실패 갈래는 서버 로그에 한 줄씩 남긴다 — 시험 출력만 조용히 한다. */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const error = console.error;
  const warn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

/** aud 와 쓰임새를 그대로 담아 돌려주는 가짜 서명(gather.test.ts 와 같은 수법). */
const signer: SignDelegationToken = async ({ audience, purpose }) => `${audience}|${purpose}`;

/* ------------------------------------------------------------------ */
/* 몸통                                                                 */
/* ------------------------------------------------------------------ */

test("🔴 upsert 몸통에 revokedAt 이 **없다** — 실으면 갓 맡긴 위임이 철회된 채로 저장된다", () => {
  const body = toDelegationPushBody(UPSERT);
  // 🔴 `=== undefined` 로 재지 않는다. 칸이 있고 값이 `undefined` 면 JSON.stringify 가
  //    지워 주기는 하지만, 그때는 「싣지 않는다」가 **우연히** 참인 것이다.
  assert.equal(Object.hasOwn(body, "revokedAt"), false, JSON.stringify(body));
  // 함께 재 둔다 — 무엇을 싣는지가 분명해야 「없다」가 뜻을 갖는다.
  assert.deepEqual(Object.keys(body).sort(), [
    "action",
    "delegateSub",
    "delegatorSub",
    "endsAt",
    "id",
    "reason",
    "startsAt",
  ]);
});

test("🔴 시각에 오프셋이 붙어 나간다 — 없으면 받는 쪽 400, 받아 적히면 아홉 시간 어긋난다", () => {
  const body = toDelegationPushBody(UPSERT);
  assert.equal(body.startsAt, "2026-11-16T15:00:00.000Z");
  assert.equal(body.endsAt, "2026-11-20T15:00:00.000Z");
  // 세 시스템의 정규식과 같은 잣대 — `Z` 또는 `±HH:MM` 이 **반드시** 있어야 한다.
  const withZone = /(Z|[+-]\d{2}:\d{2})$/;
  assert.match(body.startsAt, withZone);
  assert.match(body.endsAt, withZone);
  assert.match(toDelegationPushBody(REVOKE).revokedAt, withZone);
});

test("철회 몸통은 번호와 시각뿐이다 — 받는 쪽이 나머지를 읽지 않는다", () => {
  const body = toDelegationPushBody(REVOKE);
  assert.deepEqual(body, {
    action: "revoke",
    id: ID,
    revokedAt: "2026-11-18T04:30:00.000Z",
  });
});

test("답 읽기 — 둘은 성공이고 그 밖은 전부 실패다", () => {
  assert.equal(readDelegationPushOutcome(200, { outcome: "stored" }), "stored");
  assert.equal(readDelegationPushOutcome(200, { outcome: "not_applicable" }), "not_applicable");
  // 🔴 200 인데 모양이 다르면 **모르는 것**이다. 성공으로 읽으면 포털에만 줄이 남는다.
  assert.equal(readDelegationPushOutcome(200, {}), null);
  assert.equal(readDelegationPushOutcome(200, null), null);
  assert.equal(readDelegationPushOutcome(200, { outcome: "ok" }), null);
  assert.equal(readDelegationPushOutcome(503, { outcome: "stored" }), null);
});

/* ------------------------------------------------------------------ */
/* 전파                                                                 */
/* ------------------------------------------------------------------ */

test("🔴 셋에 동시에 보내고, 쓰임새는 dss.delegations.write 다", async () => {
  const { impl, calls } = recorder(async () => stored());

  const result = await propagateDelegation({
    plan: ALL_THREE,
    command: UPSERT,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
  }
  // 🔴 쓰임새가 한 글자라도 다르면 세 곳이 통째로 401 이다.
  assert.deepEqual(
    calls.map((call) => Reflect.get(call.init.headers as object, "authorization")),
    [
      `Bearer rf-service-system|${PORTAL_SERVICE_TOKEN_PURPOSES.delegationsWrite}`,
      `Bearer dss-inventory|${PORTAL_SERVICE_TOKEN_PURPOSES.delegationsWrite}`,
      `Bearer dss-leave|${PORTAL_SERVICE_TOKEN_PURPOSES.delegationsWrite}`,
    ]
  );
  assert.equal(PORTAL_SERVICE_TOKEN_PURPOSES.delegationsWrite, "dss.delegations.write");
  // 셋이 **같은 몸통**을 받는다 — 한 곳만 다른 값으로 가면 그 시스템만 어긋난다.
  for (const call of calls) {
    assert.equal(call.body.id, ID);
    assert.equal(call.body.delegatorSub, DELEGATOR);
    assert.equal(call.body.action, "upsert");
  }
  // 🔴 리다이렉트를 따라가지 않는다 — 따라가면 **남의 결재권을 넘기는 몸통**이 저쪽이
  //    고른 주소로 간다.
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.cache, "no-store");
});

test("🔴 not_applicable 은 성공이다 — 계정 없는 사람도 위임을 맡길 수 있어야 한다", async () => {
  const { impl } = recorder(async (url) =>
    url.startsWith("http://inv.test") ? json({ outcome: "not_applicable" }) : stored()
  );

  const result = await propagateDelegation({
    plan: ALL_THREE,
    command: UPSERT,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(failedDelegationPushes(result), []);
  assert.deepEqual(summarizeDelegationPush(result), {
    "rf-service-system": "stored",
    "dss-inventory": "not_applicable",
    "dss-leave": "stored",
  });
});

test("🔴 한 곳이 500 이면 전파 실패다 — 어디가 안 됐는지 이름으로 말한다", async () => {
  const { impl } = recorder(async (url) =>
    url.startsWith("http://leave.test") ? json({ error: "storage_failed" }, 500) : stored()
  );

  const result = await propagateDelegation({
    plan: ALL_THREE,
    command: UPSERT,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    failedDelegationPushes(result).map((row) => [row.clientId, row.reason]),
    [["dss-leave", "http_500"]]
  );
  assert.equal(
    describeDelegationPushFailure(result),
    "휴가 관리에 결재권 위임을 전달하지 못했습니다. 잠시 뒤 다시 시도해 주세요."
  );
});

test("200 인데 모양이 다르면 실패다 — 「모름」을 성공으로 읽지 않는다", async () => {
  const { impl } = recorder(async (url) =>
    url.startsWith("http://as.test") ? json({ ok: true }) : stored()
  );

  const result = await propagateDelegation({
    plan: ALL_THREE,
    command: UPSERT,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    failedDelegationPushes(result).map((row) => row.reason),
    ["bad_shape"]
  );
});

test("답이 없으면 상한에서 끊고 실패로 센다", async () => {
  const impl = ((_input: RequestInfo | URL, init?: RequestInit) =>
    neverAnswers(init ?? {})) as typeof fetch;

  const result = await propagateDelegation({
    plan: { targets: [AS], unreachable: [] },
    command: UPSERT,
    signToken: signer,
    fetchImpl: impl,
    timeoutMs: SHORT_TIMEOUT_MS,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    failedDelegationPushes(result).map((row) => row.reason),
    ["AbortError"]
  );
});

test("🔴 갈 수 없는 시스템도 실패로 센다 — 조용히 빠지면 거기만 위임이 안 걸린다", async () => {
  const { impl, calls } = recorder(async () => stored());

  const result = await propagateDelegation({
    plan: {
      targets: [AS, INVENTORY],
      unreachable: [{ clientId: "dss-leave", reason: "not_registered" }],
    },
    command: UPSERT,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(calls.length, 2, "갈 수 없는 곳에는 안 보낸다");
  assert.equal(result.ok, false);
  assert.deepEqual(
    failedDelegationPushes(result).map((row) => [row.clientId, row.reason]),
    [["dss-leave", "not_registered"]]
  );
  // 🔵 이름을 모르니 client_id 라도 말한다 — 「어디가」를 아무 말 않는 것보다 낫다.
  assert.match(describeDelegationPushFailure(result), /dss-leave/);
});

test("🔴 보낼 곳이 한 곳도 없으면 실패다 — 빈 표본으로 공짜 통과하지 않는다", async () => {
  const { impl, calls } = recorder(async () => stored());

  const result = await propagateDelegation({
    plan: { targets: [], unreachable: [] },
    command: UPSERT,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(calls.length, 0);
  assert.equal(result.ok, false);
  assert.deepEqual(
    failedDelegationPushes(result).map((row) => row.reason),
    ["no_systems"]
  );
});

test("서명이 실패한 시스템도 실패다 — 던지지 않고 나머지는 계속 간다", async () => {
  const { impl, calls } = recorder(async () => stored());
  const flaky: SignDelegationToken = async ({ audience, purpose }) => {
    if (audience === "dss-inventory") throw new Error("키를 읽지 못했습니다");
    return `${audience}|${purpose}`;
  };

  const result = await quiet(() =>
    propagateDelegation({ plan: ALL_THREE, command: UPSERT, signToken: flaky, fetchImpl: impl })
  );

  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.deepEqual(
    failedDelegationPushes(result).map((row) => [row.clientId, row.reason]),
    [["dss-inventory", "sign_failed"]]
  );
});

/* ------------------------------------------------------------------ */
/* 차례 — 전파가 먼저, 저장이 나중                                       */
/* ------------------------------------------------------------------ */

/** 전파를 흉내 낸다. 보낸 명령을 전부 적어 두고, 정해 둔 답을 차례로 돌려준다. */
function propagator(answers: boolean[]) {
  const sent: DelegationPushCommand[] = [];
  const results = [...answers];
  const propagate = async (command: DelegationPushCommand): Promise<DelegationPropagationResult> => {
    sent.push(command);
    const ok = results.shift() ?? true;
    return {
      ok,
      outcomes: [
        ok
          ? { clientId: "dss-leave", name: "휴가 관리", ok: true, outcome: "stored" }
          : { clientId: "dss-leave", name: "휴가 관리", ok: false, reason: "http_500" },
      ],
    };
  };
  return { propagate, sent };
}

test("셋 다 성공하면 저장한다 — 차례는 전파가 먼저다", async () => {
  const { propagate, sent } = propagator([true]);
  const calls: string[] = [];

  const flow = await propagateThenStore({
    command: UPSERT,
    propagate: async (command) => {
      calls.push(`push:${command.action}`);
      return propagate(command);
    },
    store: async () => {
      calls.push("store");
      return "저장됨";
    },
  });

  assert.equal(flow.status, "stored");
  assert.equal(flow.status === "stored" ? flow.value : null, "저장됨");
  // 🔴 전파가 **먼저**다. 뒤집히면 「포털에는 있는데 어느 시스템에선 안 듣는」 위임이 생긴다.
  assert.deepEqual(calls, ["push:upsert", "store"]);
  // 되돌리기는 돌지 않았다.
  assert.equal(sent.length, 1);
});

test("🔴 한 곳이라도 실패하면 **저장하지 않는다** — 이 조각의 전부", async () => {
  const { propagate, sent } = propagator([false]);
  let storeCalls = 0;

  const flow = await quiet(() =>
    propagateThenStore({
      command: UPSERT,
      propagate,
      store: async () => {
        storeCalls += 1;
        return "저장됨";
      },
      now: () => new Date("2026-11-18T00:00:00Z"),
    })
  );

  assert.equal(storeCalls, 0, "🔴 전파가 실패했는데 포털에 적었다");
  assert.equal(flow.status, "propagation_failed");
  // 🔴 그리고 **되돌리기가 돈다** — 먼저 성공한 곳에 줄이 남아 있을 수 있다.
  assert.deepEqual(
    sent.map((command) => command.action),
    ["upsert", "revoke"]
  );
  assert.deepEqual(sent[1], {
    action: "revoke",
    // 🔴 **같은 번호**여야 저쪽 줄을 찾는다.
    id: ID,
    revokedAt: new Date("2026-11-18T00:00:00Z"),
  });
  assert.equal(
    flow.status === "propagation_failed" ? flow.compensation : null,
    "reverted"
  );
});

test("전파는 다 됐는데 포털 저장이 실패하면 — 되돌리고, 오류는 그대로 돌려준다", async () => {
  const { propagate, sent } = propagator([true, true]);
  const boom = new Error("거래가 깨졌습니다");

  const flow = await quiet(() =>
    propagateThenStore({
      command: UPSERT,
      propagate,
      store: async () => {
        throw boom;
      },
    })
  );

  assert.equal(flow.status, "store_failed");
  assert.equal(flow.status === "store_failed" ? flow.error : null, boom);
  assert.equal(flow.status === "store_failed" ? flow.compensation : null, "reverted");
  assert.deepEqual(
    sent.map((command) => command.action),
    ["upsert", "revoke"]
  );
});

test("🔴 되돌리기까지 실패하면 그 사실을 남긴다 — 조각 9 가 찾을 단서", async () => {
  const { propagate } = propagator([true, false]);
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));

  let flow;
  try {
    flow = await propagateThenStore({
      command: UPSERT,
      propagate,
      store: async () => {
        throw new Error("거래가 깨졌습니다");
      },
    });
  } finally {
    console.error = original;
  }

  assert.equal(flow.status === "store_failed" ? flow.compensation : null, "revert_failed");
  // 🔴 번호가 로그에 있어야 나중에 줄을 찾아간다.
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], new RegExp(ID));
});

test("🔴 철회도 전파가 실패하면 실패다 — 그리고 되돌리지 않는다", async () => {
  const { propagate, sent } = propagator([false]);
  let storeCalls = 0;

  const flow = await quiet(() =>
    propagateThenStore({
      command: REVOKE,
      propagate,
      store: async () => {
        storeCalls += 1;
        return "저장됨";
      },
    })
  );

  assert.equal(storeCalls, 0, "🔴 철회 전파가 실패했는데 포털에 적었다");
  assert.equal(flow.status, "propagation_failed");
  // 🔴 **되돌리지 않는다.** 되살리면 거둔 위임이 부활한다 — 「거둔 줄 알았는데 안
  //    거둬진」 쪽이 더 위험하다는 것이 설계 B-13 의 판단이다.
  assert.deepEqual(
    sent.map((command) => command.action),
    ["revoke"]
  );
  assert.equal(flow.status === "propagation_failed" ? flow.compensation : null, "not_needed");
});
