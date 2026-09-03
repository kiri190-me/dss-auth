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
 *       --redirect-uri 'http://{lan}:3000/api/auth/sso/callback' \
 *       --post-logout-redirect-uri 'http://{lan}:3000/login' \
 *       --launcher-url 'http://{lan}:3000/dashboard' \
 *       --launcher-icon 🔧
 *
 *   npm run client:register -- --client-id rf-service-system \
 *       --backchannel-logout-uri 'http://{lan}:3000/api/auth/sso/backchannel-logout'
 *     → 세션이 끊겼을 때 알려 줄 주소를 등록한다. 없으면 알리지 않는다.
 *
 *   npm run client:register -- --client-id rf-service-system --rotate
 *     → 시크릿만 새로 발급
 *
 *   npm run client:register -- --client-id rf-service-system \
 *       --role SUPER_ADMIN --role ADMIN --role AS_ENGINEER
 *     → 그 시스템이 쓰는 역할 목록을 등록한다. 포털 관리 화면이 이 목록으로
 *       드롭다운을 그리고, 여기서 고른 값이 ID 토큰의 role 클레임이 된다.
 *
 * --redirect-uri와 --role은 여러 번 줄 수 있다. 둘 다 주지 않으면 기존
 * 목록을 그대로 둔다(지우지 않는다).
 *
 * ───────────────────────────────────────────────────────────────
 * 호스트 자리의 {lan}
 *
 * 주소 자리에 {lan}을 적으면, 포털이 검증하기 직전에 **자기 기계의 실제
 * 사내망 주소**로 펼쳐 평소와 똑같이 정확 일치로 대조한다. 와일드카드가
 * 아니다 — 펼친 값은 언제나 이 서버 자신의 주소이고, 요청하는 쪽이 그
 * 목록을 바꿀 수 없다(자세한 근거는 lib/oidc/redirect-uri.ts).
 *
 * 이걸 쓰면 Wi-Fi를 옮겨도 등록을 다시 하지 않아도 된다. 주소를 직접 적으면
 * 그날부터 그 주소에 묶인다. 셸이 중괄호를 건드리지 않도록 작은따옴표로
 * 감싼다.
 *
 * 지금 무엇으로 펼쳐지는지는 `npm run net:doctor`가 보여준다.
 * ───────────────────────────────────────────────────────────────
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
    .select({
      id: clients.id,
      name: clients.name,
      // 아래 shared에서 "주지 않은 값은 그대로 둔다"를 하려면 기존 값을
      // 알아야 한다.
      description: clients.description,
      postLogoutRedirectUris: clients.postLogoutRedirectUris,
      launcherUrl: clients.launcherUrl,
      launcherIcon: clients.launcherIcon,
      backchannelLogoutUri: clients.backchannelLogoutUri,
    })
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

  const availableRoles = args.many("role");

  // 주지 않은 값은 기존 값을 그대로 둔다.
  //
  // 예전에는 인자를 주지 않으면 null로 덮어썼다. 그래서 역할 목록만 더하려고
  // --client-id --role 만 주면 설명·런처 주소·런처 아이콘·로그아웃 주소가
  // 통째로 지워졌다. 등록 스크립트를 다시 부르는 이유는 대개 "한 가지를
  // 고치려고"이므로, 나머지를 지우는 쪽이 놀라움이 크다.
  const keep = <T>(next: T | undefined, previous: T | null | undefined): T | null =>
    next ?? previous ?? null;

  const postLogout = args.many("post-logout-redirect-uri");

  const shared = {
    name: name ?? existing?.name ?? clientId,
    description: keep(args.one("description"), existing?.description),
    postLogoutRedirectUris:
      postLogout.length > 0 ? postLogout : (existing?.postLogoutRedirectUris ?? []),
    launcherUrl: keep(args.one("launcher-url"), existing?.launcherUrl),
    backchannelLogoutUri: keep(
      args.one("backchannel-logout-uri"),
      existing?.backchannelLogoutUri
    ),
    launcherIcon: keep(args.one("launcher-icon"), existing?.launcherIcon),
    // 기본은 "권한을 받은 사람만". 열어두는 것보다 닫아두는 편이 안전하다.
    // 이것만은 인자가 없으면 기본값으로 돌아간다 — 접근을 여는 결정은
    // 매번 명시적이어야 하고, 실수로 열린 채 굳는 쪽이 더 위험하다.
    requiresGrant: !args.has("open-to-all"),
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(clients)
      .set({
        ...shared,
        ...(redirectUris.length > 0 ? { redirectUris } : {}),
        // redirect-uri와 같은 취급 — 주지 않으면 기존 목록을 지우지 않는다.
        // 역할 목록을 통째로 날리면 이미 부여된 역할들이 목록에 없는 값이
        // 되어 관리 화면이 설명할 수 없는 상태가 된다.
        ...(availableRoles.length > 0 ? { availableRoles } : {}),
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
    availableRoles,
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
