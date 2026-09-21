/**
 * 통합 알림 통로 점검 (브라우저 없이).
 *
 * 왜 필요한가: 포털이 각 시스템에 묻는 이 길은 **화면이 없다.** 게다가 틀려도
 * 증상은 「알림이 안 온다」 하나뿐이라 어디가 어긋났는지 가리키지 않는다 —
 * 서명 키인지, iss 인지, aud 인지, purpose 인지, 주소인지. 이 스크립트가 정상
 * 왕복 한 번과 **거절돼야 할 세 가지**를 실제로 돌려서 각각을 확인한다.
 *
 * 실행 전 포털과 각 시스템의 서버가 떠 있어야 한다:
 *   npm run dev              (다른 터미널에서, 포털 3100)
 *   (A/S 저장소에서) npm run dev
 *   npm run check:notify
 *
 * 🔴 **아무것도 바꾸지 않는다.** 읽기만 하고, 설정 저장은 부르지 않는다.
 *
 * `--conditions=react-server` 로 도는 이유: 이 스크립트가 부르는 코드가
 * Next 서버 전용 모듈("server-only")을 거쳐 간다. 그 조건이 없으면 import 에서
 * 멈춘다.
 */
import { and, eq } from "drizzle-orm";
import { getIssuer } from "../src/lib/config/env";
import { getSigningKey } from "../src/lib/crypto/keys";
import { pgClient } from "../src/lib/db/connection";
import { db } from "../src/lib/db/client";
import { clients, userClientGrants, users } from "../src/lib/db/schema";
import { listAccessibleClients } from "../src/lib/db/queries/clients";
import {
  PORTAL_SERVICE_TOKEN_PURPOSES,
  signPortalServiceToken,
  type PortalServiceTokenPurpose,
} from "../src/lib/oidc/service-token";
import { gatherNotifications } from "../src/lib/notifications/gather";
import { toNotificationSources, type NotificationSource } from "../src/lib/notifications/sources";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function sign(
  subject: string,
  audience: string,
  purpose: PortalServiceTokenPurpose
): Promise<string> {
  const { key, kid } = await getSigningKey();
  return signPortalServiceToken({ issuer: getIssuer(), audience, subject, purpose, key, kid });
}

/** 한 번 묻고 상태 코드와 본문을 본다. 던지지 않는다. */
async function ask(
  url: string,
  token: string | null
): Promise<{ status: number; body: unknown; ms: number }> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      redirect: "manual",
      cache: "no-store",
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, ms: Date.now() - started };
  } catch (error) {
    console.log(`     (연결 실패: ${error instanceof Error ? error.message : String(error)})`);
    return { status: 0, body: null, ms: Date.now() - started };
  }
}

/**
 * 점검에 쓸 사람 하나.
 *
 * A/S 에 접근 권한이 **부여된** 사람을 먼저 찾는다 — 실제로 종을 여는 사람과
 * 같은 상태여야 이 점검이 뜻이 있다. 없으면(전 직원 공개 설정이거나 아직
 * 부여하지 않았으면) 활성 사용자 아무나로 넘어간다.
 */
async function pickUser(): Promise<{ id: string } | null> {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.clientId, "rf-service-system"))
    .limit(1);

  if (client) {
    const [granted] = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(userClientGrants, eq(userClientGrants.userId, users.id))
      .where(and(eq(users.status, "ACTIVE"), eq(userClientGrants.clientId, client.id)))
      .limit(1);
    if (granted) return granted;
  }

  const [anyActive] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, "ACTIVE"))
    .limit(1);
  return anyActive ?? null;
}

async function main() {
  console.log(`\n포털 issuer: ${getIssuer()}\n`);

  const user = await pickUser();
  if (!user) {
    console.log("활성 사용자가 없습니다. 먼저 포털에 한 번 로그인하세요.");
    process.exitCode = 1;
    return;
  }

  const tiles = await listAccessibleClients(user.id);
  const { sources, skipped } = toNotificationSources(tiles);

  console.log("─".repeat(64));
  console.log("  물어볼 곳");
  console.log("─".repeat(64));
  for (const row of skipped) {
    console.log(`  ⚠ ${row.clientId} — ${row.reason} (launcher_url 을 등록하세요)`);
  }
  if (sources.length === 0) {
    console.log("  물어볼 시스템이 없습니다. 알림 통로를 가진 시스템에 접근 권한이 없습니다.");
    process.exitCode = 1;
    return;
  }
  for (const source of sources) console.log(`  · ${source.clientId} → ${source.notificationsUrl}`);

  for (const source of sources) {
    console.log(`\n─ ${source.name} (${source.clientId})`);

    // 1) 정상 왕복
    const readToken = await sign(
      user.id,
      source.clientId,
      PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead
    );
    const feed = await ask(source.notificationsUrl, readToken);
    check(`알림 통로가 200 으로 답한다 (${feed.ms}ms)`, feed.status === 200, `status ${feed.status}`);
    check(
      "답에 items 와 count 가 있다",
      typeof feed.body === "object" &&
        feed.body !== null &&
        Array.isArray((feed.body as { items?: unknown }).items),
      JSON.stringify(feed.body)?.slice(0, 200) ?? ""
    );
    const itemCount = Array.isArray((feed.body as { items?: unknown })?.items)
      ? ((feed.body as { items: unknown[] }).items.length)
      : 0;
    console.log(`     받은 줄: ${itemCount}개 (0개도 정상이다 — 저쪽에 계정이 없는 사람)`);

    // 2) 토큰 없이는 못 들어간다
    const noToken = await ask(source.notificationsUrl, null);
    check("토큰 없이 부르면 401", noToken.status === 401, `status ${noToken.status}`);

    // 3) 🔴 알림 읽기 토큰으로 설정 통로를 열 수 없다
    const wrongPurpose = await ask(source.settingsUrl, readToken);
    check(
      "🔴 알림 읽기용 토큰으로 설정을 볼 수 없다 (401)",
      wrongPurpose.status === 401,
      `status ${wrongPurpose.status}`
    );

    // 4) 설정 읽기 토큰 — 200(관리자) 또는 403(관리자 아님) 둘 다 정상이다
    const settingsToken = await sign(
      user.id,
      source.clientId,
      PORTAL_SERVICE_TOKEN_PURPOSES.notificationSettingsRead
    );
    const settings = await ask(source.settingsUrl, settingsToken);
    check(
      `설정 통로가 200 또는 403 으로 답한다 (받은 값: ${settings.status})`,
      settings.status === 200 || settings.status === 403,
      `status ${settings.status}`
    );
    if (settings.status === 403) {
      console.log("     403 = 이 사람이 저쪽 관리자가 아니다. 🔴 정상 응답이다.");
    }
  }

  // 5) 합치는 창구 전체
  console.log("\n─ 합치는 창구");
  const started = Date.now();
  const merged = await gatherNotifications({
    sources: sources as NotificationSource[],
    signToken: ({ audience, purpose }) => sign(user.id, audience, purpose),
  });
  console.log(
    `  줄 ${merged.items.length}개 · 배지 ${merged.count} · degraded=${merged.degraded} · ${Date.now() - started}ms`
  );
  check("합치는 창구가 답을 낸다", merged.degraded === false, "한 곳 이상 못 물어봤다");

  console.log("\n" + "─".repeat(64));
  console.log(`  통과 ${passed} · 실패 ${failed}`);
  console.log("─".repeat(64) + "\n");
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
