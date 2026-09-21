/**
 * 사이트 → 포털 알림 통로 점검 (브라우저 없이).
 *
 * check-notifications.ts 의 **반대 방향**이다. 저쪽은 포털이 각 시스템에 묻는
 * 길을, 이쪽은 각 사이트의 서버가 포털에 묻는 길을 실제로 돌려 본다.
 *
 * 왜 필요한가: 이 길도 화면이 없고, 틀려도 증상은 「알림이 안 온다」 하나뿐이다.
 * 게다가 이 통로의 값어치는 **거절이 제대로 되는가**에 있는데, 거절은 아무도
 * 눈으로 보지 않는다. 그래서 정상 왕복 한 번과 **거절돼야 할 다섯 가지**를
 * 진짜 서버에 대고 확인한다.
 *
 * 실행:
 *   npm run dev            (다른 터미널에서, 포털 3100)
 *   npm run check:notify:site
 *
 * 🔴 **아무것도 바꾸지 않는다.** DB 는 읽기만 하고, 포털에는 읽기 요청만 보낸다.
 *
 * ── 자격증명을 어디서 얻나 ─────────────────────────────────────────────────
 * 포털은 시크릿의 **해시만** 갖고 있어 평문을 되찾을 수 없다. 그래서 붙는
 * 쪽(사이트)의 설정에서 읽는다:
 *
 *   1. 환경변수 SITE_CLIENT_ID · SITE_CLIENT_SECRET 이 있으면 그것
 *   2. 없으면 SITE_ENV_FILE(기본값: ../RF_Service_System/.env.local)의
 *      SSO_CLIENT_ID · SSO_CLIENT_SECRET
 *
 * 🔴 읽은 값은 **어디에도 찍지 않는다.** 화면에 나오는 것은 client_id 뿐이다.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { and, eq, notExists } from "drizzle-orm";
import { getIssuer } from "../src/lib/config/env";
import { db } from "../src/lib/db/client";
import { pgClient } from "../src/lib/db/connection";
import { clients, userClientGrants, users } from "../src/lib/db/schema";

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(label: string, why: string) {
  skipped += 1;
  console.log(`  · ${label} — 건너뜀 (${why})`);
}

/** `.env` 한 줄짜리 파서. 🔴 값을 돌려줄 뿐 찍지 않는다. */
function readEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function credentials(): { clientId: string; clientSecret: string } | null {
  if (process.env.SITE_CLIENT_ID && process.env.SITE_CLIENT_SECRET) {
    return {
      clientId: process.env.SITE_CLIENT_ID,
      clientSecret: process.env.SITE_CLIENT_SECRET,
    };
  }
  const file = process.env.SITE_ENV_FILE ?? "../RF_Service_System/.env.local";
  const values = readEnvFile(file);
  if (values.SSO_CLIENT_ID && values.SSO_CLIENT_SECRET) {
    console.log(`  (자격증명을 ${file} 에서 읽었습니다)`);
    return { clientId: values.SSO_CLIENT_ID, clientSecret: values.SSO_CLIENT_SECRET };
  }
  return null;
}

function basic(clientId: string, clientSecret: string): string {
  const raw = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

type Answer = { status: number; body: unknown; cacheControl: string | null };

/** 한 번 물어본다. 던지지 않는다. */
async function ask(
  url: string,
  options: { authorization?: string; body?: string; method?: string } = {}
): Promise<Answer> {
  try {
    const response = await fetch(url, {
      method: options.method ?? "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        ...(options.authorization ? { authorization: options.authorization } : {}),
      },
      body: options.method === "GET" ? undefined : (options.body ?? ""),
      redirect: "manual",
      cache: "no-store",
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
      cacheControl: response.headers.get("cache-control"),
    };
  } catch (error) {
    console.log(`     (연결 실패: ${error instanceof Error ? error.message : String(error)})`);
    return { status: 0, body: null, cacheControl: null };
  }
}

async function main() {
  const endpoint = `${getIssuer()}/api/integration/notifications`;
  console.log(`\n통로: ${endpoint}\n`);

  const site = credentials();
  if (!site) {
    console.log(
      "자격증명을 찾지 못했습니다. SITE_CLIENT_ID·SITE_CLIENT_SECRET 를 주거나\n" +
        "SITE_ENV_FILE 로 사이트의 .env 를 가리키세요."
    );
    process.exitCode = 1;
    return;
  }
  console.log(`  부르는 사이트: ${site.clientId}`);

  const [client] = await db
    .select({ id: clients.id, requiresGrant: clients.requiresGrant, name: clients.name })
    .from(clients)
    .where(and(eq(clients.clientId, site.clientId), eq(clients.isActive, true)))
    .limit(1);
  if (!client) {
    console.log(`  ${site.clientId} 가 포털에 등록돼 있지 않습니다.`);
    process.exitCode = 1;
    return;
  }

  // 이 사이트에 **들어갈 수 있는** 활성 사용자 하나. 실제로 종을 여는 사람과
  // 같은 상태여야 이 점검이 뜻이 있다.
  const [allowed] = client.requiresGrant
    ? await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(userClientGrants, eq(userClientGrants.userId, users.id))
        .where(and(eq(users.status, "ACTIVE"), eq(userClientGrants.clientId, client.id)))
        .limit(1)
    : await db.select({ id: users.id }).from(users).where(eq(users.status, "ACTIVE")).limit(1);

  if (!allowed) {
    console.log("  이 사이트에 들어갈 수 있는 활성 사용자가 없습니다.");
    process.exitCode = 1;
    return;
  }

  console.log("\n─ 거절돼야 하는 것들");

  const noAuth = await ask(endpoint, { body: `sub=${allowed.id}` });
  check("인증 없이 부르면 401", noAuth.status === 401, `status ${noAuth.status}`);

  const badSecret = await ask(endpoint, {
    authorization: basic(site.clientId, "이건-틀린-시크릿"),
    body: `sub=${allowed.id}`,
  });
  check("시크릿이 틀리면 401", badSecret.status === 401, `status ${badSecret.status}`);

  // 🔴 진짜 시크릿은 절대 주소에 싣지 않는다. 가짜 값으로도 400 이어야 한다.
  const inQuery = await ask(`${endpoint}?client_id=${site.clientId}&client_secret=가짜값`, {
    body: `sub=${allowed.id}`,
  });
  check("🔴 비밀값이 쿼리에 실리면 400", inQuery.status === 400, `status ${inQuery.status}`);

  const noSub = await ask(endpoint, { authorization: basic(site.clientId, site.clientSecret) });
  check("sub 없이 부르면 400", noSub.status === 400, `status ${noSub.status}`);

  const unknownUser = await ask(endpoint, {
    authorization: basic(site.clientId, site.clientSecret),
    body: `sub=${randomUUID()}`,
  });
  check("없는 사람을 물으면 403", unknownUser.status === 403, `status ${unknownUser.status}`);

  const wrongMethod = await ask(endpoint, {
    method: "GET",
    authorization: basic(site.clientId, site.clientSecret),
  });
  check("GET 으로는 부를 수 없다 (405)", wrongMethod.status === 405, `status ${wrongMethod.status}`);

  // 🔴 접근 권한이 없는 사람 — 있을 때만 해 본다. 없는 상태는 정상이다
  // (전 직원이 그 시스템을 쓰는 경우). 그 경우 이 판정은 시험이 덮는다.
  if (client.requiresGrant) {
    const [outsider] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.status, "ACTIVE"),
          notExists(
            db
              .select({ one: userClientGrants.id })
              .from(userClientGrants)
              .where(
                and(
                  eq(userClientGrants.userId, users.id),
                  eq(userClientGrants.clientId, client.id)
                )
              )
          )
        )
      )
      .limit(1);

    if (outsider) {
      const denied = await ask(endpoint, {
        authorization: basic(site.clientId, site.clientSecret),
        body: `sub=${outsider.id}`,
      });
      check(
        "🔴 이 시스템에 들어갈 수 없는 사람을 물으면 403",
        denied.status === 403,
        `status ${denied.status}`
      );
    } else {
      skip("🔴 접근 권한 없는 사람 거절", "지금 전원이 이 시스템에 권한을 갖고 있다");
    }
  } else {
    skip("🔴 접근 권한 없는 사람 거절", "이 시스템은 전 직원 공개다");
  }

  console.log("\n─ 정상 왕복");

  const started = Date.now();
  const ok = await ask(endpoint, {
    authorization: basic(site.clientId, site.clientSecret),
    body: `sub=${allowed.id}`,
  });
  check(`200 으로 답한다 (${Date.now() - started}ms)`, ok.status === 200, `status ${ok.status}`);
  check("답이 어디에도 남지 않는다 (no-store)", ok.cacheControl === "no-store", String(ok.cacheControl));

  const feed = (ok.body ?? {}) as {
    items?: unknown;
    count?: unknown;
    sources?: { clientId: string; ok: boolean; count: number }[];
    degraded?: unknown;
  };
  check(
    "모양이 items · count · sources · degraded 네 칸이다",
    Array.isArray(feed.items) &&
      typeof feed.count === "number" &&
      Array.isArray(feed.sources) &&
      typeof feed.degraded === "boolean",
    JSON.stringify(ok.body)?.slice(0, 200) ?? ""
  );

  const sources = Array.isArray(feed.sources) ? feed.sources : [];
  check(
    "🔴 부른 사이트 자신은 물어보지 않았다 (되돌기 없음)",
    !sources.some((source) => source.clientId === site.clientId),
    sources.map((source) => source.clientId).join(", ")
  );

  console.log(
    `     줄 ${Array.isArray(feed.items) ? feed.items.length : 0}개 · 배지 ${feed.count} · ` +
      `degraded=${feed.degraded} · 물어본 곳 [${sources.map((s) => s.clientId).join(", ") || "없음"}]`
  );
  if (sources.length === 0) {
    console.log(
      "     물어본 곳이 없는 것은 **오늘의 정상**이다 — 알림 통로를 가진 시스템이\n" +
        "     A/S 하나뿐이라, A/S 가 물으면 포털은 아무에게도 묻지 않는다."
    );
  }

  // 두 번째 왕복은 캐시를 타야 한다(같은 사람·같은 사이트).
  const again = Date.now();
  const cached = await ask(endpoint, {
    authorization: basic(site.clientId, site.clientSecret),
    body: `sub=${allowed.id}`,
  });
  check(`다시 물어도 같은 답이다 (${Date.now() - again}ms)`, cached.status === 200 &&
    JSON.stringify(cached.body) === JSON.stringify(ok.body), `status ${cached.status}`);

  console.log("\n" + "─".repeat(64));
  console.log(`  통과 ${passed} · 실패 ${failed} · 건너뜀 ${skipped}`);
  console.log("─".repeat(64) + "\n");
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
