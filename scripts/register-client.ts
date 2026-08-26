/**
 * 사내 시스템(OIDC 클라이언트) 등록.
 *
 * 동적 등록(Dynamic Client Registration)을 구현하지 않은 이유: 시스템
 * 개수가 한 자릿수이고, "누가 우리 로그인에 붙을 수 있는가"는 사람이
 * 판단해야 하는 보안 결정이다.
 *
 * 사용법:
 *   npm run client:register
 *     → 등록된 목록 출력
 *
 *   npm run client:register -- --client-id rf-service-system \
 *       --name "DSS A/S 관리 시스템" \
 *       --redirect-uri http://192.168.1.132:3000/api/auth/sso/callback \
 *       --post-logout-redirect-uri http://192.168.1.132:3000/login \
 *       --launcher-url http://192.168.1.132:3000/dashboard \
 *       --launcher-icon 🔧
 *
 *   npm run client:register -- --client-id rf-service-system --rotate
 *     → 시크릿만 새로 발급
 *
 * --redirect-uri는 여러 번 줄 수 있다.
 */
import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pgClient } from "../src/lib/db/connection";
import { clients } from "../src/lib/db/schema";

type Args = {
  flags: Map<string, string[]>;
  has(name: string): boolean;
  one(name: string): string | undefined;
  many(name: string): string[];
};

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    const value = next && !next.startsWith("--") ? next : "";
    if (value) i += 1;
    const existing = flags.get(name) ?? [];
    existing.push(value);
    flags.set(name, existing);
  }
  return {
    flags,
    has: (name) => flags.has(name),
    one: (name) => flags.get(name)?.[0] || undefined,
    many: (name) => (flags.get(name) ?? []).filter(Boolean),
  };
}

function newSecret(): { plain: string; hash: string } {
  const plain = randomBytes(32).toString("base64url");
  return { plain, hash: createHash("sha256").update(plain, "utf8").digest("hex") };
}

function printSecret(clientId: string, secret: string) {
  console.log("\n" + "─".repeat(64));
  console.log("  아래 시크릿은 지금 한 번만 표시됩니다.");
  console.log("  DB에는 해시만 저장되므로 잃어버리면 재발급만 가능합니다.");
  console.log("─".repeat(64));
  console.log(`\n  SSO_CLIENT_ID=${clientId}`);
  console.log(`  SSO_CLIENT_SECRET=${secret}\n`);
  console.log("─".repeat(64));
  console.log("  이 값을 채팅·이메일로 보내지 말고 해당 시스템의");
  console.log("  .env.local에 직접 넣으세요.");
  console.log("─".repeat(64) + "\n");
}

async function list() {
  const rows = await db
    .select({
      clientId: clients.clientId,
      name: clients.name,
      redirectUris: clients.redirectUris,
      isActive: clients.isActive,
      requiresGrant: clients.requiresGrant,
    })
    .from(clients)
    .orderBy(clients.sortOrder);

  if (rows.length === 0) {
    console.log("등록된 시스템이 없습니다.");
    console.log("\n등록하려면 --client-id 와 --name, --redirect-uri 를 주세요.");
    return;
  }

  console.log("등록된 시스템:\n");
  for (const row of rows) {
    const badges = [
      row.isActive ? "활성" : "비활성",
      row.requiresGrant ? "권한 부여 필요" : "전 직원 공개",
    ].join(" · ");
    console.log(`  ${row.clientId}  —  ${row.name}  [${badges}]`);
    for (const uri of row.redirectUris) console.log(`      ↩ ${uri}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clientId = args.one("client-id");

  if (!clientId) {
    await list();
    return;
  }

  const [existing] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.clientId, clientId))
    .limit(1);

  // ── 시크릿만 재발급 ──
  if (args.has("rotate")) {
    if (!existing) {
      console.error(`"${clientId}"는 등록되어 있지 않습니다.`);
      process.exitCode = 1;
      return;
    }
    const secret = newSecret();
    await db
      .update(clients)
      .set({
        clientSecretHash: secret.hash,
        clientSecretRotatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(clients.id, existing.id));
    console.log(`${existing.name}의 시크릿을 재발급했습니다.`);
    console.log("이전 시크릿은 즉시 무효가 되므로 해당 시스템을 바로 갱신하세요.");
    printSecret(clientId, secret.plain);
    return;
  }

  const redirectUris = args.many("redirect-uri");
  const name = args.one("name");

  if (!existing && (!name || redirectUris.length === 0)) {
    console.error("새로 등록하려면 --name 과 --redirect-uri 가 필요합니다.");
    process.exitCode = 1;
    return;
  }

  // redirect_uri는 나중에 문자 단위로 정확 비교된다. 여기서 형태만이라도
  // 걸러 두면 "왜 안 되지" 하는 시간을 아낀다.
  for (const uri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      console.error(`redirect-uri가 올바른 주소가 아닙니다: ${uri}`);
      process.exitCode = 1;
      return;
    }
    if (parsed.hash) {
      console.error(`redirect-uri에 #을 넣을 수 없습니다: ${uri}`);
      process.exitCode = 1;
      return;
    }
    if (parsed.protocol === "http:") {
      console.warn(
        `  경고: ${uri} 는 http입니다. 서버의 OIDC_ALLOW_HTTP_REDIRECT_URIS=true 일 때만 동작하며, HTTPS 전환 시 반드시 되돌려야 합니다.`
      );
    }
  }

  const shared = {
    name: name ?? existing?.name ?? clientId,
    description: args.one("description") ?? null,
    postLogoutRedirectUris: args.many("post-logout-redirect-uri"),
    launcherUrl: args.one("launcher-url") ?? null,
    launcherIcon: args.one("launcher-icon") ?? null,
    // 기본은 "권한을 받은 사람만". 열어두는 것보다 닫아두는 편이 안전하다.
    requiresGrant: !args.has("open-to-all"),
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(clients)
      .set({
        ...shared,
        ...(redirectUris.length > 0 ? { redirectUris } : {}),
      })
      .where(eq(clients.id, existing.id));
    console.log(`"${clientId}" 정보를 수정했습니다. (시크릿은 그대로입니다)`);
    console.log("시크릿을 새로 받으려면 --rotate 를 쓰세요.");
    return;
  }

  const secret = newSecret();
  await db.insert(clients).values({
    clientId,
    clientSecretHash: secret.hash,
    redirectUris,
    ...shared,
  });

  console.log(`"${clientId}"를 등록했습니다.`);
  printSecret(clientId, secret.plain);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
