import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_TIMEOUT_MS } from "@/lib/notifications/gather";
import { PORTAL_SERVICE_TOKEN_PURPOSES } from "@/lib/oidc/service-token";
import { APPROVAL_READ_TIMEOUT_MS, type SignApprovalToken } from "./gather";
import { gatherScreenApprovals, SCREEN_APPROVAL_READ_TIMEOUT_MS } from "./screen-gather";
import type { ApprovalSource } from "./sources";

/**
 * ============================================================================
 * 셋에 동시에 묻기 — 🔴 **「없다」와 「못 물어봤다」와 「답할 수 없다」가 다르다**
 * ============================================================================
 * 이 파일이 지키는 것:
 *  · 한 곳이 죽어도 나머지 결재는 화면에 선다.
 *  · `unavailable`(저쪽이 답할 수 없다)과 `failed`(못 물어봤다)가 **다르게**
 *    올라가고, `degraded` 는 `failed` 일 때만 참이다.
 *  · 🔴 상한이 **1.5초**다. 메일 쪽 5초를 쓰면 승인함(3초)이 답을 도착 직전에
 *    버린다 — 증상은 「포털에 물어보지 못했습니다」 하나뿐이라 원인을 안 가리킨다.
 * ============================================================================
 */

const AS: ApprovalSource = {
  clientId: "rf-service-system",
  name: "A/S 관리",
  approvalsUrl: "http://as.test/api/integration/approvals",
};
const INVENTORY: ApprovalSource = {
  clientId: "dss-inventory",
  name: "재고 관리",
  approvalsUrl: "http://inventory.test/api/integration/approvals",
};
const LEAVE: ApprovalSource = {
  clientId: "dss-leave",
  name: "휴가 관리",
  approvalsUrl: "http://leave.test/api/integration/approvals",
};

/** 시험을 짧게 두려고 줄인다. 실제 값은 SCREEN_APPROVAL_READ_TIMEOUT_MS. */
const SHORT_TIMEOUT_MS = 60;

/** 🔴 값은 전부 가짜다. */
function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "REPAIR_INSPECTION",
    kindLabel: "접수건 검수 결재",
    subject: `TEST-${id}`,
    detail: "",
    requestedAt: "2026-10-21T04:05:06.000Z",
    href: `http://as.test:3000/repair-cases/${id}/approval`,
    ...over,
  };
}

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

/** 🔴 신호를 듣는 가짜다. 안 들으면 타임아웃 시험이 영영 안 끝난다. */
function neverAnswers(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    );
  });
}

/** 실패 갈래는 서버 로그에 한 줄씩 남긴다 — 시험 출력만 조용히 한다. */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

const signer: SignApprovalToken = async ({ audience, purpose }) => `${audience}|${purpose}`;

// ───────────────────────────────────────────── 상한

test("🔴 읽기 상한은 1.5초다 — 메일 쪽 5초를 쓰면 승인함이 답을 버린다", () => {
  assert.equal(SCREEN_APPROVAL_READ_TIMEOUT_MS, 1500);
  // 🔴 종과 같은 값이다(사람이 화면 앞에서 기다리는 길이라서).
  assert.equal(SCREEN_APPROVAL_READ_TIMEOUT_MS, READ_TIMEOUT_MS);
  // 🔴 메일 쪽 값과는 달라야 한다. 같아지는 날 승인함이 3초에 먼저 끊는다.
  assert.notEqual(SCREEN_APPROVAL_READ_TIMEOUT_MS, APPROVAL_READ_TIMEOUT_MS);
  // 승인함의 PORTAL_APPROVALS_TIMEOUT_MS 는 3000 이다(저장소가 달라 못 가져온다).
  assert.ok(SCREEN_APPROVAL_READ_TIMEOUT_MS < 3000);
});

test("답이 없으면 끊는다 — 사람이 화면 앞에서 기다리는 시간이다", async () => {
  const { impl } = recorder(async (_url, init) => neverAnswers(init));

  const started = Date.now();
  const inbox = await quiet(() =>
    gatherScreenApprovals({
      sources: [AS],
      signToken: signer,
      fetchImpl: impl,
      timeoutMs: SHORT_TIMEOUT_MS,
    })
  );

  assert.equal(inbox.degraded, true);
  assert.equal(inbox.sources[0].status, "failed");
  assert.ok(Date.now() - started < 2000, "타임아웃이 걸리지 않았다");
});

// ───────────────────────────────────────────── 모아서 내주기

test("🔴 셋에 묻고 줄을 합친다 — key·sourceId·sourceName 이 붙는다", async () => {
  const { impl, calls } = recorder(async (url) =>
    url.startsWith("http://as.test")
      ? json({ items: [row("a1"), row("a2")], count: 2 })
      : json({ items: [row("i1", { kind: "PART_ISSUE_APPROVAL" })], count: 1 })
  );

  const inbox = await gatherScreenApprovals({
    sources: [AS, INVENTORY],
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(calls.length, 2);
  assert.equal(inbox.items.length, 3, "표본이 비면 아래 단언이 공짜로 통과한다");
  assert.deepEqual(
    inbox.items.map((item) => [item.key, item.sourceId, item.sourceName]),
    [
      ["rf-service-system:a1", "rf-service-system", "A/S 관리"],
      ["rf-service-system:a2", "rf-service-system", "A/S 관리"],
      ["dss-inventory:i1", "dss-inventory", "재고 관리"],
    ]
  );
  // 🔴 일곱 칸도 함께 올라온다 — 셋만 맞고 나머지가 비면 승인함이 줄을 버린다.
  assert.equal(inbox.items[0].kindLabel, "접수건 검수 결재");
  assert.equal(inbox.items[0].subject, "TEST-a1");
  assert.equal(inbox.items[0].requestedAt, "2026-10-21T04:05:06.000Z");
  assert.match(inbox.items[0].href, /^http:\/\//);

  assert.equal(inbox.count, 3);
  assert.equal(inbox.degraded, false);
  assert.deepEqual(inbox.sources, [
    { clientId: "rf-service-system", name: "A/S 관리", status: "ok", count: 2 },
    { clientId: "dss-inventory", name: "재고 관리", status: "ok", count: 1 },
  ]);
});

test("🔴 셈은 **올려 보내는 줄 수**다 — 저쪽이 센 숫자가 아니다", async () => {
  // 저쪽 계약은 count = items.length 다. 다르면 줄이 깨진 것이고, 그때 깨진
  // 숫자를 나르면 승인함의 배지와 목록이 서로 다른 말을 한다.
  const { impl } = recorder(async () => json({ items: [row("a1")], count: 99 }));
  const inbox = await gatherScreenApprovals({ sources: [AS], signToken: signer, fetchImpl: impl });

  assert.equal(inbox.count, 1);
  assert.deepEqual(inbox.sources, [
    { clientId: "rf-service-system", name: "A/S 관리", status: "ok", count: 1 },
  ]);
});

test("토큰은 시스템마다 따로 굽고, 쓰임새는 **알림 읽기 그대로**다", async () => {
  const { impl, calls } = recorder(async () => json({ items: [], count: 0 }));
  await gatherScreenApprovals({ sources: [AS, LEAVE], signToken: signer, fetchImpl: impl });

  assert.deepEqual(
    calls.map((call) => (call.init.headers as Record<string, string>).authorization),
    [
      `Bearer rf-service-system|${PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead}`,
      `Bearer dss-leave|${PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead}`,
    ]
  );
  // 🔴 포털이 먼저 바꾸면 통로 셋이 통째로 401 이 된다.
  assert.equal(PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead, "dss.notifications.read");
});

test("리다이렉트를 따라가지 않고, 답을 캐시하지 않는다", async () => {
  const { impl, calls } = recorder(async () => json({ items: [], count: 0 }));
  await gatherScreenApprovals({ sources: [AS], signToken: signer, fetchImpl: impl });

  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.cache, "no-store");
});

// ───────────────────────────────────────────── 셋 가운데 둘은 고장이 아니다

test("🔴 한 시스템이 죽어도 나머지 줄은 그대로 올라온다", async () => {
  const { impl } = recorder(async (url) => {
    if (url.startsWith("http://as.test")) throw new Error("ECONNREFUSED");
    return json({ items: [row("i1")], count: 1 });
  });

  const inbox = await quiet(() =>
    gatherScreenApprovals({ sources: [AS, INVENTORY], signToken: signer, fetchImpl: impl })
  );

  assert.deepEqual(
    inbox.items.map((item) => item.key),
    ["dss-inventory:i1"]
  );
  assert.equal(inbox.count, 1);
  assert.equal(inbox.degraded, true);
  assert.deepEqual(inbox.sources[0], {
    clientId: "rf-service-system",
    name: "A/S 관리",
    status: "failed",
    reason: "Error",
  });
});

test("🔴 `unavailable` 과 `failed` 가 다르게 올라오고, degraded 는 failed 일 때만 참이다", async () => {
  const { impl } = recorder(async (url) => {
    if (url.startsWith("http://as.test")) return json({ items: [row("a1")], count: 1 });
    if (url.startsWith("http://inventory.test")) return json({ error: "nope" }, 503);
    return json({ items: [], count: 0, unavailable: "employee_not_linked" });
  });

  const inbox = await quiet(() =>
    gatherScreenApprovals({
      sources: [AS, INVENTORY, LEAVE],
      signToken: signer,
      fetchImpl: impl,
    })
  );

  assert.deepEqual(inbox.sources, [
    { clientId: "rf-service-system", name: "A/S 관리", status: "ok", count: 1 },
    { clientId: "dss-inventory", name: "재고 관리", status: "failed", reason: "http_503" },
    {
      clientId: "dss-leave",
      name: "휴가 관리",
      status: "unavailable",
      reason: "employee_not_linked",
    },
  ]);
  assert.equal(inbox.degraded, true, "재고를 못 물어봤다");
});

test("🔴 `unavailable` 만 있으면 degraded 가 **거짓**이다 — 저쪽은 멀쩡히 답했다", async () => {
  const { impl } = recorder(async () =>
    json({ items: [], count: 0, unavailable: "employee_not_linked" })
  );
  const inbox = await gatherScreenApprovals({
    sources: [LEAVE],
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(inbox.degraded, false);
  assert.deepEqual(inbox.items, []);
  assert.equal(inbox.sources[0].status, "unavailable");
});

test("🔴 사정이 적혀 오면 줄이 함께 왔어도 그 사정을 올린다", async () => {
  const { impl } = recorder(async () =>
    json({ items: [row("l1")], count: 1, unavailable: "employee_not_linked" })
  );
  const inbox = await gatherScreenApprovals({
    sources: [LEAVE],
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(inbox.sources[0].status, "unavailable");
  assert.deepEqual(inbox.items, [], "사정이 적힌 답의 줄은 내주지 않는다");
});

test("200 인데 모양이 다르면 「없다」가 아니라 「못 물어봤다」다", async () => {
  const { impl } = recorder(async () => json({ 결재: [] }));
  const inbox = await quiet(() =>
    gatherScreenApprovals({ sources: [AS], signToken: signer, fetchImpl: impl })
  );

  assert.deepEqual(inbox.sources, [
    { clientId: "rf-service-system", name: "A/S 관리", status: "failed", reason: "bad_shape" },
  ]);
  assert.equal(inbox.degraded, true);
});

test("401 은 못 물어본 것으로 센다 — 토큰이 거절된 것이라 고쳐야 한다", async () => {
  const { impl } = recorder(async () => json({ error: "invalid_token" }, 401));
  const inbox = await quiet(() =>
    gatherScreenApprovals({ sources: [AS], signToken: signer, fetchImpl: impl })
  );
  assert.equal((inbox.sources[0] as { reason: string }).reason, "http_401");
});

test("서명이 실패해도 던지지 않는다 — 그 시스템만 빠진다", async () => {
  const { impl } = recorder(async () => json({ items: [], count: 0 }));
  const inbox = await quiet(() =>
    gatherScreenApprovals({
      sources: [AS],
      signToken: async () => {
        throw new Error("키가 없다");
      },
      fetchImpl: impl,
    })
  );

  assert.deepEqual(inbox.sources, [
    { clientId: "rf-service-system", name: "A/S 관리", status: "failed", reason: "sign_failed" },
  ]);
});

// ───────────────────────────────────────────── 묻지도 못한 시스템

test("🔴 주소를 몰라 **묻지도 못한** 시스템은 조용히 빠지지 않는다 — 이름과 함께 올라간다", async () => {
  const { impl, calls } = recorder(async () => json({ items: [row("a1")], count: 1 }));

  const inbox = await gatherScreenApprovals({
    sources: [AS],
    unreachable: [{ clientId: "dss-leave", name: "휴가 관리", reason: "no_launcher_url" }],
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(calls.length, 1, "묻지도 못한 곳에 요청을 보내지 않는다");
  assert.deepEqual(inbox.sources[1], {
    clientId: "dss-leave",
    name: "휴가 관리",
    status: "failed",
    reason: "no_launcher_url",
  });
  // 🔵 이름이 비면 승인함이 그 줄을 버려 화면에 아무 말도 안 뜬다.
  assert.notEqual(inbox.sources[1].name, "");
  assert.equal(inbox.degraded, true);
  assert.equal(inbox.count, 1, "나머지 결재는 그대로 올라간다");
});

test("물어볼 곳이 없으면 아무것도 묻지 않고, degraded 도 아니다", async () => {
  const { impl, calls } = recorder(async () => json({ items: [], count: 0 }));
  const inbox = await gatherScreenApprovals({ sources: [], signToken: signer, fetchImpl: impl });

  assert.equal(calls.length, 0);
  // 🔵 결재 통로가 있는 시스템에 한 곳도 못 들어가는 사람이다. 「결재할 건이
  //    없습니다」가 맞는 말이고, 승인함도 그렇게 읽는다(그쪽 approvalEmptyState).
  assert.deepEqual(inbox, { items: [], count: 0, sources: [], degraded: false });
});
