import assert from "node:assert/strict";
import { test } from "node:test";
import { PORTAL_SERVICE_TOKEN_PURPOSES } from "@/lib/oidc/service-token";
import { APPROVAL_READ_TIMEOUT_MS, type SignApprovalToken } from "./gather";
import { APPROVAL_HISTORY_READ_TIMEOUT_MS, gatherApprovalHistory } from "./history-gather";
import type { ApprovalHistoryPeriod } from "./history-period";
import { SCREEN_APPROVAL_READ_TIMEOUT_MS } from "./screen-gather";
import type { ApprovalHistorySource } from "./sources";

/**
 * ============================================================================
 * 셋에 동시에 묻기 — 🔴 **한 집이 죽어도 나머지를 주되, 「못 물었다」를 말한다**
 * ============================================================================
 * 이 파일이 지키는 것:
 *  · 한 곳이 죽어도 나머지 두 집의 내역은 그려진다.
 *  · 🔴 **죽은 집이 조용히 빠지지 않는다** — `sources[]` 에 이름과 까닭이 서고
 *    `degraded` 가 참이다. 조용히 빠지면 사람은 「그 기간에 결재한 게 없구나」로
 *    읽고 아무도 신고하지 않는다.
 *  · 🔴 셋을 합쳐 **새것부터** 선다(집별로 뭉쳐 있지 않다).
 *  · 🔴 기간이 **`Z` 꼴로 구워져** 주소에 실린다.
 *
 * 🔴 **값은 전부 가짜다.**
 * ============================================================================
 */

const AS: ApprovalHistorySource = {
  clientId: "rf-service-system",
  name: "A/S 관리",
  historyUrl: "http://as.test/api/integration/approval-history",
};
const INVENTORY: ApprovalHistorySource = {
  clientId: "dss-inventory",
  name: "재고 관리",
  historyUrl: "http://inventory.test/api/integration/approval-history",
};
const LEAVE: ApprovalHistorySource = {
  clientId: "dss-leave",
  name: "휴가 관리",
  historyUrl: "http://leave.test/api/integration/approval-history",
};

/** 11월 한 달. 🔴 `+09:00` 으로 적어 두고 **구워진 글자**를 본다. */
const NOVEMBER: ApprovalHistoryPeriod = {
  from: new Date("2026-11-01T00:00:00+09:00"),
  to: new Date("2026-12-01T00:00:00+09:00"),
};

/** 시험을 짧게 두려고 줄인다. 실제 값은 APPROVAL_HISTORY_READ_TIMEOUT_MS. */
const SHORT_TIMEOUT_MS = 60;

/** 🔴 값은 전부 가짜다. */
function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    subject: `TEST-${id}`,
    approvalName: "가짜 결재",
    decidedAt: "2026-11-03T04:05:06.000Z",
    decision: "APPROVED",
    relation: "SELF",
    counterpartName: null,
    href: `http://as.test:3000/x/${id}`,
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

/* ───────────────────────────────── 상한 */

test("🔴 읽기 상한은 1.5초다 — 더 길면 승인함(3초)이 답을 도착 직전에 버린다", () => {
  assert.equal(APPROVAL_HISTORY_READ_TIMEOUT_MS, 1500);
  assert.ok(APPROVAL_HISTORY_READ_TIMEOUT_MS < 3000);
  // 🔵 지금은 결재함과 같은 값이지만 **같은 상수를 나눠 쓰지 않는다**(한쪽만 올릴 수 있어야 한다).
  assert.equal(APPROVAL_HISTORY_READ_TIMEOUT_MS, SCREEN_APPROVAL_READ_TIMEOUT_MS);
  // 🔴 밤에 도는 메일 쪽 5초를 쓰면 안 된다.
  assert.notEqual(APPROVAL_HISTORY_READ_TIMEOUT_MS, APPROVAL_READ_TIMEOUT_MS);
});

test("답이 없으면 끊는다 — 사람이 화면 앞에서 기다리는 시간이다", async () => {
  const { impl } = recorder(async (_url, init) => neverAnswers(init));

  const history = await quiet(() =>
    gatherApprovalHistory({
      sources: [AS],
      period: NOVEMBER,
      signToken: signer,
      fetchImpl: impl,
      timeoutMs: SHORT_TIMEOUT_MS,
    })
  );

  assert.equal(history.degraded, true);
  assert.equal(history.sources[0].status, "failed");
  assert.equal(history.entries.length, 0);
});

/* ───────────────────────────────── 묻는 모양 */

test("🔴 기간이 `Z` 꼴로 구워져 주소에 실린다 — `+` 가 섞이면 세 집이 한꺼번에 400 이다", async () => {
  const { impl, calls } = recorder(async () => json({ entries: [] }));

  await gatherApprovalHistory({
    sources: [AS],
    period: NOVEMBER,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes("+"), false, "주소에 + 가 섞였다");
  assert.equal(calls[0].url.includes(" "), false);

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("from"), "2026-10-31T15:00:00.000Z");
  assert.equal(url.searchParams.get("to"), "2026-11-30T15:00:00.000Z");
  // 🔴 주소에 실리는 것은 기간 둘뿐이다 — 사람 번호는 토큰에만 있다.
  assert.deepEqual([...url.searchParams.keys()].sort(), ["from", "to"]);
});

test("🔴 쓰임새는 아직 알림 읽기다 — 포털이 먼저 바꾸면 세 집이 통째로 401 이다", async () => {
  const { impl, calls } = recorder(async () => json({ entries: [] }));

  await gatherApprovalHistory({
    sources: [AS],
    period: NOVEMBER,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(
    calls[0].init.headers &&
      (calls[0].init.headers as Record<string, string>).authorization,
    `Bearer rf-service-system|${PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead}`
  );
  assert.equal(calls[0].init.method, "GET");
  // 🔴 리다이렉트를 따라가면 토큰이 저쪽이 고른 주소로 따라간다.
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.cache, "no-store");
});

test("셋을 **동시에** 묻는다 — 차례로 물으면 상한이 세 배가 된다", async () => {
  let inFlight = 0;
  let peak = 0;
  const { impl } = recorder(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return json({ entries: [] });
  });

  await gatherApprovalHistory({
    sources: [AS, INVENTORY, LEAVE],
    period: NOVEMBER,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(peak, 3);
});

/* ───────────────────────────────── 한 집이 죽어도 */

test("🔴 한 집이 죽어도 나머지 둘의 내역은 선다 — 그 사람이 한 결재가 그만큼 있다", async () => {
  const { impl } = recorder(async (url) => {
    if (url.startsWith("http://inventory.test")) return json({ error: "boom" }, 500);
    if (url.startsWith("http://as.test")) return json({ entries: [row("a1")] });
    return json({ entries: [row("l1")] });
  });

  const history = await quiet(() =>
    gatherApprovalHistory({
      sources: [AS, INVENTORY, LEAVE],
      period: NOVEMBER,
      signToken: signer,
      fetchImpl: impl,
    })
  );

  assert.equal(history.entries.length, 2);
  assert.equal(history.count, 2);

  // 🔴 **죽은 집이 조용히 빠지지 않는다.** 이름과 까닭이 함께 올라간다.
  const failed = history.sources.filter((source) => source.status === "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].clientId, "dss-inventory");
  assert.equal(failed[0].name, "재고 관리");
  assert.equal(failed[0].status === "failed" && failed[0].reason, "http_500");
  assert.equal(history.degraded, true);
});

test("🔴 404 `not_enabled` 도 「못 물었다」다 — 「그 집에 내역이 없다」가 아니다", async () => {
  const { impl } = recorder(async () => json({ error: "not_enabled" }, 404));

  const history = await quiet(() =>
    gatherApprovalHistory({
      sources: [AS],
      period: NOVEMBER,
      signToken: signer,
      fetchImpl: impl,
    })
  );

  assert.equal(history.sources[0].status, "failed");
  assert.equal(history.sources[0].status === "failed" && history.sources[0].reason, "http_404");
  assert.equal(history.degraded, true);
});

test("🔴 400 `invalid_period` 도 「못 물었다」로 올라간다 — 빈 목록으로 보이면 안 된다", async () => {
  const { impl } = recorder(async () => json({ error: "invalid_period" }, 400));

  const history = await quiet(() =>
    gatherApprovalHistory({
      sources: [AS],
      period: NOVEMBER,
      signToken: signer,
      fetchImpl: impl,
    })
  );

  assert.equal(history.sources[0].status === "failed" && history.sources[0].reason, "http_400");
  assert.equal(history.degraded, true);
});

test("200 인데 모양이 다르면 「못 물었다」다 — 「없다」로 읽으면 그 집이 조용히 사라진다", async () => {
  const { impl } = recorder(async () => json({ items: [] }));

  const history = await quiet(() =>
    gatherApprovalHistory({
      sources: [AS],
      period: NOVEMBER,
      signToken: signer,
      fetchImpl: impl,
    })
  );

  assert.equal(history.sources[0].status === "failed" && history.sources[0].reason, "bad_shape");
  assert.equal(history.degraded, true);
});

test("토큰 서명이 실패해도 나머지는 묻는다", async () => {
  const { impl } = recorder(async () => json({ entries: [row("l1")] }));
  const picky: SignApprovalToken = async ({ audience }) => {
    if (audience === "rf-service-system") throw new Error("키가 없다");
    return "token";
  };

  const history = await quiet(() =>
    gatherApprovalHistory({
      sources: [AS, LEAVE],
      period: NOVEMBER,
      signToken: picky,
      fetchImpl: impl,
    })
  );

  assert.equal(history.entries.length, 1);
  assert.equal(history.sources[0].status === "failed" && history.sources[0].reason, "sign_failed");
  assert.equal(history.degraded, true);
});

test("🔴 주소를 몰라 **묻지도 못한** 집도 이름과 함께 올라간다", async () => {
  const { impl } = recorder(async () => json({ entries: [] }));

  const history = await gatherApprovalHistory({
    sources: [AS],
    unreachable: [{ clientId: "dss-leave", name: "휴가 관리", reason: "no_launcher_url" }],
    period: NOVEMBER,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(history.sources.length, 2);
  const last = history.sources[1];
  assert.equal(last.status, "failed");
  assert.equal(last.name, "휴가 관리");
  assert.equal(last.status === "failed" && last.reason, "no_launcher_url");
  assert.equal(history.degraded, true);
});

/* ───────────────────────────────── 멀쩡할 때 */

test("🔴 셋이 다 답하면 `degraded` 가 거짓이고 집마다 줄 수가 선다", async () => {
  const { impl } = recorder(async (url) => {
    if (url.startsWith("http://as.test")) return json({ entries: [row("a1"), row("a2")] });
    if (url.startsWith("http://inventory.test")) return json({ entries: [] });
    return json({ entries: [row("l1")] });
  });

  const history = await gatherApprovalHistory({
    sources: [AS, INVENTORY, LEAVE],
    period: NOVEMBER,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.equal(history.degraded, false);
  assert.equal(history.count, 3);
  assert.deepEqual(
    history.sources.map((source) => [source.clientId, source.status === "ok" && source.count]),
    [
      ["rf-service-system", 2],
      ["dss-inventory", 0],
      ["dss-leave", 1],
    ]
  );
});

test("🔴 셋을 합쳐 **새것부터** 세운다 — 집별로 뭉쳐 있으면 안 된다", async () => {
  const { impl } = recorder(async (url) => {
    if (url.startsWith("http://as.test")) {
      return json({
        entries: [
          row("a-new", { decidedAt: "2026-11-30T00:00:00.000Z" }),
          row("a-old", { decidedAt: "2026-11-01T00:00:00.000Z" }),
        ],
      });
    }
    return json({ entries: [row("l-mid", { decidedAt: "2026-11-15T00:00:00.000Z" })] });
  });

  const history = await gatherApprovalHistory({
    sources: [AS, LEAVE],
    period: NOVEMBER,
    signToken: signer,
    fetchImpl: impl,
  });

  assert.deepEqual(
    history.entries.map((entry) => entry.id),
    ["a-new", "l-mid", "a-old"]
  );
  // 🔴 집 이름이 줄마다 붙는다 — 각 집은 제 이름을 모른다.
  assert.deepEqual(
    history.entries.map((entry) => entry.sourceName),
    ["A/S 관리", "휴가 관리", "A/S 관리"]
  );
});

test("🔴 `count` 는 **올려 보낸 줄 수**다 — 버린 줄은 집마다 `dropped` 로 선다", async () => {
  const { impl } = recorder(async () =>
    json({ entries: [row("ok"), row("bad", { decision: "SKIPPED" }), row("")] })
  );

  const history = await quiet(() =>
    gatherApprovalHistory({
      sources: [AS],
      period: NOVEMBER,
      signToken: signer,
      fetchImpl: impl,
    })
  );

  assert.equal(history.count, 1);
  assert.equal(history.entries.length, 1);
  assert.equal(history.sources[0].status === "ok" && history.sources[0].dropped, 2);
  // 🔵 버린 줄은 **고장이 아니다** — 물어보기는 됐다.
  assert.equal(history.degraded, false);
});

test("물어볼 곳이 하나도 없으면 빈 답이고 고장이 아니다", async () => {
  const history = await gatherApprovalHistory({
    sources: [],
    period: NOVEMBER,
    signToken: signer,
    fetchImpl: (() => {
      throw new Error("부르면 안 된다");
    }) as unknown as typeof fetch,
  });

  assert.deepEqual(history, { entries: [], count: 0, sources: [], degraded: false });
});
