import assert from "node:assert/strict";
import { test } from "node:test";
import { PORTAL_SERVICE_TOKEN_PURPOSES } from "@/lib/oidc/service-token";
import {
  gatherNotificationSettings,
  gatherNotifications,
  pushNotificationSettings,
  type SignServiceToken,
} from "./gather";
import type { NotificationSource } from "./sources";

const AS: NotificationSource = {
  clientId: "rf-service-system",
  name: "DSS A/S 관리 시스템",
  notificationsUrl: "http://as.test/api/integration/notifications",
  settingsUrl: "http://as.test/api/integration/notification-settings",
};

const METERS: NotificationSource = {
  clientId: "dss-meters",
  name: "계측기 관리",
  notificationsUrl: "http://meters.test/api/integration/notifications",
  settingsUrl: "http://meters.test/api/integration/notification-settings",
};

/** 시험을 짧게 두려고 타임아웃을 줄인다. 실제 값은 READ_TIMEOUT_MS. */
const SHORT_TIMEOUT_MS = 60;

function feedBody(id: string) {
  return {
    items: [
      {
        id,
        kind: "REPAIR_CASE_APPROVAL",
        kindLabel: "접수건 결재 대기",
        targetKey: `REPAIR_CASE:${id}`,
        subject: `${id} 결재 대기`,
        detail: "삼성전자",
        href: `http://as.test/repair-cases/${id}`,
      },
    ],
    count: 1,
  };
}

const SETTINGS_BODY = {
  roles: [
    { code: "ADMIN", label: "관리자", editable: true },
    { code: "SUPER_ADMIN", label: "최고관리자", editable: false },
  ],
  kinds: [
    {
      kind: "REPAIR_CASE_APPROVAL",
      label: "접수건 결재 대기",
      description: "결재를 기다리는 접수 건이 있을 때",
      enabled: true,
      defaultEnabled: true,
      roles: {
        ADMIN: { receives: true, defaultReceives: true },
        SUPER_ADMIN: { receives: true, defaultReceives: true },
      },
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { url: string; init: RequestInit };

/** 부른 자취를 남기는 가짜 fetch. */
function recorder(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Call[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

/**
 * 끊길 때까지 답하지 않는 시스템. 🔴 **죽었을 때**를 그리는 시늉이다 —
 * 연결이 거절되는 것(위 ECONNREFUSED)과 달리 아무 답도 오지 않는 쪽이라,
 * 끊어 주지 않으면 종이 영원히 안 뜬다.
 */
function neverAnswers(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    );
  });
}

/** 서명하는 시늉. 무엇을 어디에 구웠는지 남긴다. */
function signer() {
  const baked: { audience: string; purpose: string }[] = [];
  const signToken: SignServiceToken = async ({ audience, purpose }) => {
    baked.push({ audience, purpose });
    return `token-for:${audience}:${purpose}`;
  };
  return { signToken, baked };
}

/** 실패가 예정된 시험에서 서버 로그를 조용히 시킨다. */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

// ──────────────────────────────────────────────────────────── 알림 모으기

test("두 시스템에 동시에 묻는다 — 하나씩 기다리지 않는다", async () => {
  const wait = 80;
  const { impl, calls } = recorder(
    async (url) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(json(feedBody(url.includes("as.test") ? "AS-1" : "M-1"))), wait);
      })
  );

  const started = Date.now();
  const feed = await gatherNotifications({
    sources: [AS, METERS],
    signToken: signer().signToken,
    fetchImpl: impl,
    timeoutMs: 1000,
  });
  const elapsed = Date.now() - started;

  assert.equal(calls.length, 2);
  assert.equal(feed.items.length, 2);
  // 순서대로 물었다면 160ms 가까이 걸린다. 넉넉히 잡아도 한 번 치보다 조금 더다.
  assert.ok(elapsed < wait * 1.8, `${elapsed}ms`);
});

test("🔴 한 시스템이 죽어도 나머지 결과가 나온다", async () => {
  const { impl } = recorder(async (url) => {
    if (url.startsWith("http://as.test")) throw new Error("ECONNREFUSED");
    return json(feedBody("M-1"));
  });

  const feed = await quiet(() =>
    gatherNotifications({
      sources: [AS, METERS],
      signToken: signer().signToken,
      fetchImpl: impl,
      timeoutMs: 1000,
    })
  );

  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].sourceId, "dss-meters");
  assert.equal(feed.degraded, true);
  assert.deepEqual(
    feed.sources.map((row) => [row.clientId, row.ok]),
    [
      ["rf-service-system", false],
      ["dss-meters", true],
    ]
  );
});

test("🔴 한 시스템이 느려도 타임아웃 뒤 나머지가 나온다", async () => {
  const { impl } = recorder(async (url, init) =>
    url.startsWith("http://as.test") ? neverAnswers(init) : json(feedBody("M-1"))
  );

  const started = Date.now();
  const feed = await quiet(() =>
    gatherNotifications({
      sources: [AS, METERS],
      signToken: signer().signToken,
      fetchImpl: impl,
      timeoutMs: SHORT_TIMEOUT_MS,
    })
  );
  const elapsed = Date.now() - started;

  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].sourceId, "dss-meters");
  assert.equal(feed.degraded, true);
  // 타임아웃보다 오래 붙들고 있으면 안 된다. 그 시간이 곧 종이 안 뜨는 시간이다.
  assert.ok(elapsed < SHORT_TIMEOUT_MS * 8, `${elapsed}ms`);
});

test("모두 느려도 답은 나온다 — 종이 통째로 안 뜨는 일은 없다", async () => {
  const { impl } = recorder(async (_url, init) => neverAnswers(init));

  const feed = await quiet(() =>
    gatherNotifications({
      sources: [AS, METERS],
      signToken: signer().signToken,
      fetchImpl: impl,
      timeoutMs: SHORT_TIMEOUT_MS,
    })
  );
  assert.deepEqual(feed.items, []);
  assert.equal(feed.count, 0);
  assert.equal(feed.degraded, true);
});

test("2xx 가 아닌 답은 실패로 다루고 나머지를 보여 준다", async () => {
  for (const status of [401, 403, 404, 500]) {
    const { impl } = recorder(async (url) =>
      url.startsWith("http://as.test") ? json({ error: "x" }, status) : json(feedBody("M-1"))
    );
    const feed = await quiet(() =>
      gatherNotifications({
        sources: [AS, METERS],
        signToken: signer().signToken,
        fetchImpl: impl,
        timeoutMs: 1000,
      })
    );
    assert.equal(feed.items.length, 1, String(status));
    assert.equal(feed.degraded, true, String(status));
  }
});

test("답의 모양이 깨져도 터지지 않는다", async () => {
  const { impl } = recorder(async () => new Response("이건 JSON 이 아니다", { status: 200 }));
  const feed = await gatherNotifications({
    sources: [AS],
    signToken: signer().signToken,
    fetchImpl: impl,
    timeoutMs: 1000,
  });
  // 200 으로 답했으니 「물어봤다」는 사실은 참이다. 줄이 없을 뿐이다.
  assert.deepEqual(feed.items, []);
  assert.equal(feed.degraded, false);
});

test("🔴 빈 목록은 정상이다 — degraded 가 서지 않는다", async () => {
  // A/S 실측: 활성 사용자 12명 중 포털 계정과 이어진 사람은 4명이었다.
  // 나머지에게 이 답이 온다.
  const { impl } = recorder(async () => json({ items: [], count: 0 }));
  const feed = await gatherNotifications({
    sources: [AS],
    signToken: signer().signToken,
    fetchImpl: impl,
    timeoutMs: 1000,
  });
  assert.deepEqual(feed.items, []);
  assert.equal(feed.count, 0);
  assert.equal(feed.degraded, false);
});

test("물어볼 곳이 없으면 아무 데도 묻지 않는다", async () => {
  const { impl, calls } = recorder(async () => json(feedBody("X")));
  const feed = await gatherNotifications({
    sources: [],
    signToken: signer().signToken,
    fetchImpl: impl,
  });
  assert.equal(calls.length, 0);
  assert.equal(feed.degraded, false);
});

test("서명이 실패해도 나머지 시스템은 나온다", async () => {
  const { impl } = recorder(async () => json(feedBody("M-1")));
  const signToken: SignServiceToken = async ({ audience }) => {
    if (audience === "rf-service-system") throw new Error("키를 읽을 수 없습니다");
    return "token";
  };

  const feed = await quiet(() =>
    gatherNotifications({ sources: [AS, METERS], signToken, fetchImpl: impl, timeoutMs: 1000 })
  );
  assert.equal(feed.items.length, 1);
  assert.equal(feed.degraded, true);
});

// ─────────────────────────────────────────────────────── 토큰이 실리는 방식

test("🔴 통로마다 다른 purpose 로 굽는다", async () => {
  const { impl } = recorder(async (url) =>
    url.endsWith("notifications") ? json(feedBody("A")) : json(SETTINGS_BODY)
  );

  const read = signer();
  await gatherNotifications({ sources: [AS], signToken: read.signToken, fetchImpl: impl });
  assert.deepEqual(read.baked, [
    { audience: "rf-service-system", purpose: PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead },
  ]);

  const settingsRead = signer();
  await gatherNotificationSettings({
    sources: [AS],
    signToken: settingsRead.signToken,
    fetchImpl: impl,
  });
  assert.deepEqual(settingsRead.baked, [
    {
      audience: "rf-service-system",
      purpose: PORTAL_SERVICE_TOKEN_PURPOSES.notificationSettingsRead,
    },
  ]);

  const write = signer();
  const { impl: writeImpl } = recorder(async () => json({ ok: true, changedCount: 1 }));
  await pushNotificationSettings({
    source: AS,
    changes: [{ kind: "REPAIR_CASE_APPROVAL", enabled: true, roles: { ADMIN: true } }],
    signToken: write.signToken,
    fetchImpl: writeImpl,
  });
  assert.deepEqual(write.baked, [
    {
      audience: "rf-service-system",
      purpose: PORTAL_SERVICE_TOKEN_PURPOSES.notificationSettingsWrite,
    },
  ]);
});

test("🔴 aud 는 그 시스템의 client_id 다 — 시스템마다 따로 굽는다", async () => {
  const { impl } = recorder(async () => json(feedBody("A")));
  const { signToken, baked } = signer();
  await gatherNotifications({ sources: [AS, METERS], signToken, fetchImpl: impl });
  assert.deepEqual(
    baked.map((row) => row.audience).sort(),
    ["dss-meters", "rf-service-system"]
  );
});

test("토큰은 Authorization 머리말로 간다 — 주소에 실리지 않는다", async () => {
  const { impl, calls } = recorder(async () => json(feedBody("A")));
  await gatherNotifications({ sources: [AS], signToken: signer().signToken, fetchImpl: impl });

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(
    headers.authorization,
    `Bearer token-for:rf-service-system:${PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead}`
  );
  // 쿼리는 접근 로그와 브라우저 히스토리에 그대로 남는다.
  assert.ok(!calls[0].url.includes("token"), calls[0].url);
  assert.ok(!calls[0].url.includes("?"), calls[0].url);
});

test("🔴 리다이렉트를 따라가지 않는다 — 토큰이 남의 주소로 따라가면 안 된다", async () => {
  const { impl, calls } = recorder(async () => json(feedBody("A")));
  await gatherNotifications({ sources: [AS], signToken: signer().signToken, fetchImpl: impl });
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.cache, "no-store");
});

// ──────────────────────────────────────────────────────────── 설정 모으기

test("설정을 읽어 시스템별로 담는다", async () => {
  const { impl } = recorder(async () => json(SETTINGS_BODY));
  const overview = await gatherNotificationSettings({
    sources: [AS],
    signToken: signer().signToken,
    fetchImpl: impl,
  });

  assert.equal(overview.degraded, false);
  const [system] = overview.systems;
  assert.equal(system.clientId, "rf-service-system");
  assert.equal(system.status, "ok");
  if (system.status !== "ok") return;
  // 🔴 역할 이름은 그 시스템이 글자로 보내 준다. 포털에 코드표가 없다.
  assert.deepEqual(
    system.roles.map((role) => role.label),
    ["관리자", "최고관리자"]
  );
  assert.equal(system.kinds[0].label, "접수건 결재 대기");
});

test("🔴 403 은 정상 응답이다 — 고장으로 세지 않는다", async () => {
  // A/S 는 설정 읽기·쓰기 둘 다 관리자 이상만 허용한다.
  const { impl } = recorder(async () =>
    json({ error: "forbidden", message: "관리자 이상만 알림 설정을 볼 수 있습니다." }, 403)
  );
  const overview = await gatherNotificationSettings({
    sources: [AS],
    signToken: signer().signToken,
    fetchImpl: impl,
  });

  assert.equal(overview.systems[0].status, "forbidden");
  assert.equal(overview.degraded, false);
});

test("설정을 못 물어보면 그 시스템만 unavailable 이 된다", async () => {
  const { impl } = recorder(async (url) => {
    if (url.startsWith("http://as.test")) throw new Error("ECONNREFUSED");
    return json(SETTINGS_BODY);
  });
  const overview = await quiet(() =>
    gatherNotificationSettings({
      sources: [AS, METERS],
      signToken: signer().signToken,
      fetchImpl: impl,
      timeoutMs: 1000,
    })
  );

  assert.equal(overview.systems[0].status, "unavailable");
  assert.equal(overview.systems[1].status, "ok");
  assert.equal(overview.degraded, true);
});

test("설정 답의 모양이 다르면 반쪽짜리 표를 그리지 않는다", async () => {
  const { impl } = recorder(async () => json({ roles: [{ code: "ADMIN" }], kinds: [] }));
  const overview = await quiet(() =>
    gatherNotificationSettings({ sources: [AS], signToken: signer().signToken, fetchImpl: impl })
  );
  assert.equal(overview.systems[0].status, "unavailable");
  assert.equal(overview.degraded, true);
});

// ──────────────────────────────────────────────────────────── 설정 보내기

test("저장은 그 시스템으로 PUT 한다 — 본문은 changes 하나다", async () => {
  const { impl, calls } = recorder(async () => json({ ok: true, changedCount: 2 }));
  const changes = [{ kind: "REPAIR_CASE_APPROVAL", enabled: false, roles: { ADMIN: false } }];

  const result = await pushNotificationSettings({
    source: AS,
    changes,
    signToken: signer().signToken,
    fetchImpl: impl,
  });

  assert.deepEqual(result, { status: "ok", changedCount: 2 });
  assert.equal(calls[0].url, AS.settingsUrl);
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { changes });
});

test("저장이 거절되면 까닭을 그대로 옮긴다", async () => {
  const { impl } = recorder(async () =>
    json({ error: "forbidden", message: "관리자 이상만 알림 설정을 바꿀 수 있습니다." }, 403)
  );
  const result = await pushNotificationSettings({
    source: AS,
    changes: [],
    signToken: signer().signToken,
    fetchImpl: impl,
  });
  assert.equal(result.status, "forbidden");
  assert.equal(
    result.status === "forbidden" ? result.message : "",
    "관리자 이상만 알림 설정을 바꿀 수 있습니다."
  );
});

test("저장 값이 잘못됐다는 답과 저장을 못 했다는 답을 구분한다", async () => {
  const bad = recorder(async () => json({ error: "invalid_request", message: "종류가 없습니다." }, 400));
  const invalid = await pushNotificationSettings({
    source: AS,
    changes: [],
    signToken: signer().signToken,
    fetchImpl: bad.impl,
  });
  assert.equal(invalid.status, "invalid");

  const dead = recorder(async () => {
    throw new Error("ECONNREFUSED");
  });
  const unavailable = await quiet(() =>
    pushNotificationSettings({
      source: AS,
      changes: [],
      signToken: signer().signToken,
      fetchImpl: dead.impl,
      timeoutMs: 1000,
    })
  );
  assert.equal(unavailable.status, "unavailable");
});

test("저장이 느리면 실패로 돌아온다 — 성공을 못 본 채 기다리지 않는다", async () => {
  const { impl } = recorder(async (_url, init) => neverAnswers(init));
  const result = await quiet(() =>
    pushNotificationSettings({
      source: AS,
      changes: [],
      signToken: signer().signToken,
      fetchImpl: impl,
      timeoutMs: SHORT_TIMEOUT_MS,
    })
  );
  assert.equal(result.status, "unavailable");
});
