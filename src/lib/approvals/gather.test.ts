import assert from "node:assert/strict";
import { test } from "node:test";
import { PORTAL_SERVICE_TOKEN_PURPOSES } from "@/lib/oidc/service-token";
import { gatherApprovals, type SignApprovalToken } from "./gather";
import type { ApprovalSource } from "./sources";

/**
 * 세 통로에 동시에 묻기.
 *
 * 🔴 여기서 가장 중요한 것은 **한 곳이 죽어도 나머지로 메일이 나간다**는 것이다.
 * 그리고 **쓰임새 글자**가 바뀌지 않았는지도 함께 잰다 — 바뀌면 통로 셋이 통째로
 * 401 이 되고, 증상은 「메일이 안 온다」 하나뿐이다.
 *
 * 🔵 실패는 던지지 않고 `outcomes` 로 돌아온다. 그 줄이 작업 기록에 그대로 찍히는
 * 것은 approvals/run.ts 의 `describeApprovalMailRun` 이 맡는다.
 */

const AS: ApprovalSource = {
  clientId: "rf-service-system",
  name: "A/S 관리",
  approvalsUrl: "http://as.test/api/integration/approvals",
};
const LEAVE: ApprovalSource = {
  clientId: "dss-leave",
  name: "휴가 관리",
  approvalsUrl: "http://leave.test/api/integration/approvals",
};

/** 시험을 짧게 두려고 타임아웃을 줄인다. 실제 값은 APPROVAL_READ_TIMEOUT_MS. */
const SHORT_TIMEOUT_MS = 60;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { url: string; init: RequestInit };

function recorder(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Call[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

/**
 * 🔴 **신호를 듣는 가짜**다. 진짜 fetch 는 `signal` 이 끊기면 던지는데, 그것을
 * 흉내 내지 않으면 타임아웃 시험이 영영 안 끝난다(실제로 한 번 매달렸다).
 */
function neverAnswers(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    );
  });
}

/** 이 파일의 실패 갈래들은 서버 로그에 한 줄씩 남긴다 — 시험 출력만 조용히 한다. */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

/** aud 와 쓰임새를 그대로 담아 돌려주는 가짜 서명. */
const signer: SignApprovalToken = async ({ audience, purpose }) => `${audience}|${purpose}`;

test("세 통로에 묻고 줄을 합친다 — 시스템이 함께 붙는다", async () => {
  const { impl, calls } = recorder(async (url) =>
    url.startsWith("http://as.test")
      ? json({ items: [{ id: "A:1", kind: "QUOTE_APPROVAL" }], count: 1 })
      : json({ items: [{ id: "L:1", kind: "LEAVE_REQUEST" }], count: 1 })
  );

  const result = await gatherApprovals({
    sources: [AS, LEAVE],
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(result.items, [
    { clientId: "rf-service-system", id: "A:1", kind: "QUOTE_APPROVAL" },
    { clientId: "dss-leave", id: "L:1", kind: "LEAVE_REQUEST" },
  ]);
  assert.equal(result.degraded, false);
  assert.deepEqual(result.outcomes, [
    { clientId: "rf-service-system", status: "ok", count: 1 },
    { clientId: "dss-leave", status: "ok", count: 1 },
  ]);
});

test("🔴 토큰은 시스템마다 따로 굽고, 쓰임새는 알림 읽기 그대로다", async () => {
  const { impl, calls } = recorder(async () => json({ items: [], count: 0 }));

  await gatherApprovals({ sources: [AS, LEAVE], signToken: signer, fetchImpl: impl });

  const headers = calls.map((call) => (call.init.headers as Record<string, string>).authorization);
  assert.deepEqual(headers, [
    `Bearer rf-service-system|${PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead}`,
    `Bearer dss-leave|${PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead}`,
  ]);
  // 🔴 쓰임새를 먼저 바꾸면 통로 셋이 401 이 된다(gather.ts 머리말).
  assert.equal(PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead, "dss.notifications.read");
});

test("리다이렉트를 따라가지 않고, 답을 캐시하지 않는다", async () => {
  const { impl, calls } = recorder(async () => json({ items: [], count: 0 }));
  await gatherApprovals({ sources: [AS], signToken: signer, fetchImpl: impl });

  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.method, "GET");
});

test("🔴 한 시스템이 죽어도 나머지 줄은 그대로 나온다", async () => {
  const { impl } = recorder(async (url) => {
    if (url.startsWith("http://as.test")) throw new Error("ECONNREFUSED");
    return json({ items: [{ id: "L:1", kind: "LEAVE_REQUEST" }], count: 1 });
  });

  const result = await gatherApprovals({
    sources: [AS, LEAVE],
    signToken: signer,
    fetchImpl: impl,
  });

  assert.deepEqual(result.items, [
    { clientId: "dss-leave", id: "L:1", kind: "LEAVE_REQUEST" },
  ]);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.outcomes[0], {
    clientId: "rf-service-system",
    status: "failed",
    reason: "Error",
  });
});

test("401 은 못 물어본 것으로 센다 — 토큰이 거절된 것이라 고쳐야 한다", async () => {
  const { impl } = recorder(async () => json({ error: "invalid_token" }, 401));
  const result = await gatherApprovals({ sources: [AS], signToken: signer, fetchImpl: impl });

  assert.deepEqual(result.outcomes, [
    { clientId: "rf-service-system", status: "failed", reason: "http_401" },
  ]);
  assert.equal(result.degraded, true);
});

test("200 인데 모양이 다르면 「없다」가 아니라 「못 물어봤다」다", async () => {
  const { impl } = recorder(async () => json({ 결재: [] }));
  const result = await gatherApprovals({ sources: [AS], signToken: signer, fetchImpl: impl });

  assert.deepEqual(result.outcomes, [
    { clientId: "rf-service-system", status: "failed", reason: "bad_shape" },
  ]);
});

test("🔴 휴가의 계정 미연결은 「결재가 없다」와 따로 센다", async () => {
  const { impl } = recorder(async () =>
    json({ items: [], count: 0, unavailable: "employee_not_linked" })
  );

  const result = await gatherApprovals({ sources: [LEAVE], signToken: signer, fetchImpl: impl });

  assert.deepEqual(result.outcomes, [
    { clientId: "dss-leave", status: "unavailable", reason: "employee_not_linked" },
  ]);
  // 🔵 못 물어본 것은 아니다 — 저쪽은 멀쩡히 답했다.
  assert.equal(result.degraded, false);
  assert.deepEqual(result.items, []);
});

test("답이 없으면 끊는다 — 사람 수만큼 곱해지는 시간이다", async () => {
  const { impl } = recorder(async (_url, init) => neverAnswers(init));

  const started = Date.now();
  const result = await quiet(() =>
    gatherApprovals({
      sources: [AS],
      signToken: signer,
      fetchImpl: impl,
      timeoutMs: SHORT_TIMEOUT_MS,
    })
  );

  assert.equal(result.degraded, true);
  assert.equal(result.outcomes[0].status, "failed");
  assert.ok(Date.now() - started < 2000, "타임아웃이 걸리지 않았다");
});

test("서명이 실패해도 던지지 않는다 — 그 시스템만 빠진다", async () => {
  const { impl } = recorder(async () => json({ items: [], count: 0 }));
  const result = await quiet(() =>
    gatherApprovals({
      sources: [AS],
      signToken: async () => {
        throw new Error("키가 없다");
      },
      fetchImpl: impl,
    })
  );

  assert.deepEqual(result.outcomes, [
    { clientId: "rf-service-system", status: "failed", reason: "sign_failed" },
  ]);
});

test("물어볼 곳이 없으면 아무것도 묻지 않는다", async () => {
  const { impl, calls } = recorder(async () => json({ items: [], count: 0 }));
  const result = await gatherApprovals({ sources: [], signToken: signer, fetchImpl: impl });

  assert.equal(calls.length, 0);
  assert.deepEqual(result, { items: [], outcomes: [], degraded: false });
});
