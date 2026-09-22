/**
 * 사내 시스템 접근 권한 부여 / 회수.
 *
 * "우리 회사 사람인가"(users.status)와 "이 시스템을 쓸 사람인가"는 다른
 * 질문이라는 user_client_grants의 전제를 그대로 따른다. 이 스크립트는 그
 * 표에 행을 넣고 빼는 유일한 수단이다.
 *
 * 관리 화면이 아니라 CLI로 먼저 만든 이유: 부여 대상이 한 자릿수이고,
 * client:register / sso:link 와 같은 자리에 두는 편이 "이 일은 사람이
 * 의식적으로 한다"는 성격을 드러낸다. 관리 화면 버튼은 나중에 이 로직을
 * 서버 액션으로 옮겨 붙이면 된다.
 *
 * 사용법:
 *   npm run client:grant
 *     → 시스템별로 누가 들어갈 수 있는지 전부 출력
 *
 *   npm run client:grant -- --client rf-service-system
 *     → 그 시스템의 명단만
 *
 *   npm run client:grant -- --client rf-service-system --user 홍길동 --by 최희만
 *     → 부여
 *
 *   npm run client:grant -- --client rf-service-system --user 홍길동 --by 최희만 --revoke
 *     → 회수. 🔴 관리 화면과 똑같이 **그 시스템에 열려 있던 세션도 끊는다**
 *       (판정은 src/lib/auth/grant-revocation.ts 하나뿐이다).
 *
 *   npm run client:grant -- --client rf-service-system --user 홍길동 \
 *       --role AS_ENGINEER --by 최희만
 *     → 부여하면서 그 시스템에서의 역할까지 지정한다. 이미 권한이 있으면
 *       역할만 바꾼다.
 *
 * --role 로 줄 수 있는 값은 그 시스템에 등록된 목록뿐이다
 * (clients.available_roles, npm run client:register -- --role 로 등록).
 *
 * 🔴 역할을 쓰는 시스템에 **새로 부여할 때는 --role 이 필수다.** 역할이 빈
 * 부여 행은 관리 화면이 설명할 수 없는 상태를 만든다(아래 부여 갈래의 주석).
 *
 * --user 와 --by 는 사용자 id(UUID) · 이메일 · 표시 이름 중 무엇으로도 준다.
 * 이름이 겹치면 거절하고 id를 요구한다.
 */
import { and, asc, eq } from "drizzle-orm";
import {
  cutSessionsForRevokedGrant,
  sessionCutNotice,
} from "../src/lib/auth/grant-revocation";
import { db, pgClient } from "../src/lib/db/connection";
import {
  auditLogs,
  clients,
  userClientGrants,
  users,
} from "../src/lib/db/schema";
// 🔴 "server-only" 모듈이다. package.json의 client:grant가
// --conditions=react-server 로 부르는 이유가 이것이고, 그 조건이 없으면 이
// import 에서 프로세스가 죽는다(check:notify와 같은 사정).
import { sendLogoutNotice } from "../src/lib/oidc/backchannel-logout";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Args = {
  has(name: string): boolean;
  one(name: string): string | undefined;
};

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    const value = next && !next.startsWith("--") ? next : "";
    if (value) i += 1;
    flags.set(name, value);
  }
  return {
    has: (name) => flags.has(name),
    one: (name) => flags.get(name) || undefined,
  };
}

type FoundUser = {
  id: string;
  displayName: string;
  email: string | null;
  status: string;
  isPortalAdmin: boolean;
};

const USER_COLUMNS = {
  id: users.id,
  displayName: users.displayName,
  email: users.email,
  status: users.status,
  isPortalAdmin: users.isPortalAdmin,
};

/**
 * id → 이메일 → 표시 이름 순으로 찾는다. 앞에서 찾으면 뒤는 보지 않는다 —
 * 누군가의 표시 이름이 다른 사람의 이메일과 같아 엉뚱한 사람이 잡히는 일을
 * 막는다.
 */
async function findUsers(token: string): Promise<FoundUser[]> {
  if (UUID_PATTERN.test(token)) {
    return db.select(USER_COLUMNS).from(users).where(eq(users.id, token));
  }

  const byEmail = await db
    .select(USER_COLUMNS)
    .from(users)
    .where(eq(users.email, token));
  if (byEmail.length > 0) return byEmail;

  return db
    .select(USER_COLUMNS)
    .from(users)
    .where(eq(users.displayName, token));
}

async function resolveUser(
  token: string,
  label: string
): Promise<FoundUser | undefined> {
  const found = await findUsers(token);

  if (found.length === 0) {
    console.error(`${label} "${token}" 에 해당하는 사용자가 없습니다.`);
    console.error("인자 없이 실행하면 전체 명단을 볼 수 있습니다.");
    return undefined;
  }

  // 표시 이름에는 유일 제약이 없다. 동명이인을 만나면 고르지 않고 멈춘다 —
  // 권한을 엉뚱한 사람에게 주는 것보다 한 번 더 묻는 편이 낫다.
  if (found.length > 1) {
    console.error(`${label} "${token}" 에 해당하는 사용자가 ${found.length}명입니다.`);
    console.error("id로 지정하세요:");
    for (const row of found) {
      console.error(`  ${row.id}  ${row.displayName}`);
    }
    return undefined;
  }

  return found[0];
}

/**
 * 감사 기록 실패가 본래 작업을 실패시키지 않는다 — audit.ts와 같은 원칙이다.
 * 다만 CLI는 사람이 결과를 보고 있으므로 조용히 넘어가지 않고 크게 알린다.
 */
async function audit(entry: typeof auditLogs.$inferInsert): Promise<void> {
  try {
    await db.insert(auditLogs).values(entry);
  } catch (error) {
    console.error("");
    console.error("  ⚠ 감사 로그를 남기지 못했습니다.");
    console.error("    권한 변경 자체는 반영되었습니다. 아래 오류를 확인하세요.");
    console.error("   ", error);
  }
}

async function list(clientIdFilter?: string): Promise<void> {
  const rows = await db
    .select({
      id: clients.id,
      clientId: clients.clientId,
      name: clients.name,
      requiresGrant: clients.requiresGrant,
      availableRoles: clients.availableRoles,
      isActive: clients.isActive,
    })
    .from(clients)
    .orderBy(asc(clients.sortOrder), asc(clients.name));

  const targets = clientIdFilter
    ? rows.filter((row) => row.clientId === clientIdFilter)
    : rows;

  if (targets.length === 0) {
    console.log(
      clientIdFilter
        ? `"${clientIdFilter}" 라는 시스템이 등록되어 있지 않습니다.`
        : "등록된 시스템이 없습니다. npm run client:register 로 먼저 등록하세요."
    );
    return;
  }

  for (const client of targets) {
    const grantees = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        status: users.status,
        role: userClientGrants.role,
        grantedAt: userClientGrants.grantedAt,
      })
      .from(userClientGrants)
      .innerJoin(users, eq(users.id, userClientGrants.userId))
      .where(eq(userClientGrants.clientId, client.id))
      .orderBy(asc(users.displayName));

    const inactive = client.isActive ? "" : " · 비활성";
    console.log("");
    console.log(`${client.name}  [${client.clientId}]${inactive}`);
    console.log(
      client.availableRoles.length > 0
        ? `  역할: ${client.availableRoles.join(" · ")}`
        : "  역할을 쓰지 않는 시스템입니다."
    );

    if (!client.requiresGrant) {
      console.log("  전 직원 공개 — 승인된 사람은 모두 들어갈 수 있습니다.");
      if (grantees.length > 0) {
        console.log(`  (부여 기록 ${grantees.length}건이 남아 있지만 지금은 판정에 쓰이지 않습니다)`);
      }
      continue;
    }

    if (grantees.length === 0) {
      console.log("  권한을 받은 사람 없음 — 아무도 들어갈 수 없습니다.");
      continue;
    }

    console.log(`  권한을 받은 사람 ${grantees.length}명:`);
    for (const row of grantees) {
      const when = row.grantedAt.toISOString().slice(0, 10);
      const state = row.status === "ACTIVE" ? "" : ` (${row.status})`;
      // 역할을 쓰는 시스템인데 역할이 비어 있으면 눈에 띄게 알린다. 그
      // 사용자는 들어갈 수는 있지만 role 클레임 없이 들어가고, 받는 쪽이
      // 그것을 어떻게 다룰지는 그쪽 사정이다.
      const role = client.availableRoles.length === 0
        ? ""
        : row.role
          ? ` · ${row.role}`
          : " · ⚠ 역할 없음";
      console.log(`    ${row.displayName}${state}${role} · ${when} 부여`);
      console.log(`      ${row.id}`);
    }
  }

  console.log("");
  console.log("부여하려면:");
  console.log("  npm run client:grant -- --client <client-id> --user <이름|id> --by <관리자 이름|id>");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const clientIdArg = args.one("client");
  const userArg = args.one("user");
  const byArg = args.one("by");
  const revoke = args.has("revoke");

  if (!userArg) {
    if (revoke) {
      console.error("--revoke 는 --user 와 함께 씁니다.");
      process.exitCode = 1;
      return;
    }
    await list(clientIdArg);
    return;
  }

  if (!clientIdArg) {
    console.error("--user 를 줄 때는 --client 도 함께 지정하세요.");
    process.exitCode = 1;
    return;
  }

  // granted_by가 NOT NULL이다. "누가 열어줬는가"는 이 표의 존재 이유 중
  // 하나이므로 기본값으로 얼버무리지 않고 반드시 받는다.
  if (!byArg) {
    console.error("--by 로 이 작업을 하는 포털 관리자를 지정하세요.");
    console.error("  예: --by 최희만");
    process.exitCode = 1;
    return;
  }

  const [client] = await db
    .select({
      id: clients.id,
      clientId: clients.clientId,
      name: clients.name,
      requiresGrant: clients.requiresGrant,
      availableRoles: clients.availableRoles,
      isActive: clients.isActive,
      // 아래 회수 갈래가 "그 시스템의 세션을 끊을지"를 판정하는 데 쓴다
      // (admin-access.ts의 같은 select와 같은 까닭).
      backchannelLogoutUri: clients.backchannelLogoutUri,
    })
    .from(clients)
    .where(eq(clients.clientId, clientIdArg));

  if (!client) {
    console.error(`"${clientIdArg}" 라는 시스템이 등록되어 있지 않습니다.`);
    console.error("npm run client:register 로 등록된 목록을 볼 수 있습니다.");
    process.exitCode = 1;
    return;
  }

  const target = await resolveUser(userArg, "--user");
  if (!target) {
    process.exitCode = 1;
    return;
  }

  const actor = await resolveUser(byArg, "--by");
  if (!actor) {
    process.exitCode = 1;
    return;
  }

  // 관리 화면과 같은 규칙 — 접근 권한을 조정하는 일은 포털 관리자의 몫이다.
  if (!actor.isPortalAdmin) {
    console.error(`${actor.displayName} 은(는) 포털 관리자가 아닙니다.`);
    console.error("권한 부여는 포털 관리자만 할 수 있습니다.");
    console.error("관리자 지정은 npm run admin:promote 를 쓰세요.");
    process.exitCode = 1;
    return;
  }

  // 역할은 그 시스템에 등록된 목록에서만 고를 수 있다. 오타 하나가 받는
  // 쪽에서 "모르는 역할"이 되어 로그인을 막거나, 더 나쁘게는 그쪽이
  // 관대하게 해석해 엉뚱한 권한이 되는 것을 여기서 끊는다.
  const roleArg = args.one("role");
  if (roleArg !== undefined) {
    if (client.availableRoles.length === 0) {
      console.error(`"${client.name}" 은(는) 역할을 쓰지 않는 시스템입니다.`);
      console.error("역할 목록을 먼저 등록하세요:");
      console.error(`  npm run client:register -- --client-id ${client.clientId} --role <역할> ...`);
      process.exitCode = 1;
      return;
    }
    if (!client.availableRoles.includes(roleArg)) {
      console.error(`"${roleArg}" 은(는) "${client.name}" 의 역할이 아닙니다.`);
      console.error(`쓸 수 있는 역할: ${client.availableRoles.join(" · ")}`);
      process.exitCode = 1;
      return;
    }
  }

  const [existing] = await db
    .select({
      id: userClientGrants.id,
      role: userClientGrants.role,
      grantedAt: userClientGrants.grantedAt,
    })
    .from(userClientGrants)
    .where(
      and(
        eq(userClientGrants.userId, target.id),
        eq(userClientGrants.clientId, client.id)
      )
    );

  if (revoke) {
    if (!existing) {
      console.log(`${target.displayName} 은(는) 이미 "${client.name}" 권한이 없습니다.`);
      return;
    }

    await db.delete(userClientGrants).where(eq(userClientGrants.id, existing.id));

    await audit({
      actorUserId: actor.id,
      actionType: "GRANT_REMOVED",
      targetEntity: "user_client_grants",
      targetRecordId: existing.id,
      previousValue: {
        userId: target.id,
        displayName: target.displayName,
        grantedAt: existing.grantedAt.toISOString(),
      },
      clientId: client.clientId,
    });

    // 🔴 관리 화면(admin-access.ts)이 부르는 그 판정을 **그대로** 부른다.
    //
    // 여기가 비어 있던 동안 이 명령은 "이미 발급된 세션은 끊기지 않습니다"라고
    // 정직하게 찍고 있었지만, 그것이 곧 문제였다 — 화면으로 회수하면 끊기고
    // 명령줄로 회수하면 안 끊겼다. 급할 때 잡는 것은 명령줄이고, 관리자는
    // 두 길이 같은 일을 한다고 믿는다.
    //
    // 무엇을 끊고 무엇을 건너뛰는지·왜 그 시스템 하나에만 보내는지는
    // grant-revocation.ts 머리말에 있다. 여기서 판정을 다시 쓰지 않는다.
    //
    // 부여 행을 **지운 뒤에** 부른다. 순서를 뒤집으면 통보와 삭제 사이에 그
    // 사람이 다시 로그인해 세션을 새로 만들 수 있다.
    const outcome = await cutSessionsForRevokedGrant(
      {
        // 🔴 권한을 빼앗긴 그 사람(--user)이다. actor(--by)가 아니다 —
        // 여기가 바뀌면 회수를 실행한 관리자가 로그아웃된다.
        userId: target.id,
        displayName: target.displayName,
        actorUserId: actor.id,
        grantRecordId: existing.id,
        client: {
          clientId: client.clientId,
          requiresGrant: client.requiresGrant,
          isActive: client.isActive,
          backchannelLogoutUri: client.backchannelLogoutUri,
        },
      },
      { notifyLogout: sendLogoutNotice, audit }
    );

    console.log(`${target.displayName} 의 "${client.name}" 접근 권한을 회수했습니다.`);
    // 화면과 같은 문구를 쓴다. 뒷말로 붙이려고 앞에 공백이 하나 붙어 있어
    // 그것만 떼고 한 줄로 찍는다.
    const notice = sessionCutNotice(outcome).trim();
    if (notice) console.log(notice);
    return;
  }

  if (existing) {
    const when = existing.grantedAt.toISOString().slice(0, 10);

    if (roleArg === undefined || roleArg === existing.role) {
      const role = existing.role ? ` · 역할 ${existing.role}` : "";
      console.log(
        `${target.displayName} 은(는) 이미 "${client.name}" 권한이 있습니다. (${when} 부여${role})`
      );
      return;
    }

    await db
      .update(userClientGrants)
      .set({ role: roleArg })
      .where(eq(userClientGrants.id, existing.id));

    await audit({
      actorUserId: actor.id,
      actionType: "GRANT_ROLE_CHANGED",
      targetEntity: "user_client_grants",
      targetRecordId: existing.id,
      previousValue: { role: existing.role },
      newValue: {
        role: roleArg,
        userId: target.id,
        displayName: target.displayName,
      },
      clientId: client.clientId,
    });

    console.log(
      `${target.displayName} 의 "${client.name}" 역할을 ${existing.role ?? "(없음)"} → ${roleArg} 로 바꿨습니다.`
    );
    console.log("이미 로그인해 있는 세션에는 반영되지 않습니다 — 다음 로그인부터입니다.");
    return;
  }

  // 🔴 역할을 쓰는 시스템에 **역할 없이** 부여하지 않는다.
  //
  // 전에는 행을 넣고 나서 "⚠ 역할을 지정하지 않았습니다"만 찍었다. 그렇게 생긴
  // 행은 관리 화면이 설명할 수 없는 상태였고(그 시스템의 역할 목록에 "역할
  // 없음"이라는 줄이 없다), 고르개가 그 자리에 「권한 없음」을 보여주다가
  // 관리자가 「적용」을 누르면 **멀쩡한 권한이 회수됐다.** 화면 쪽은 지금 그
  // 상태를 제 이름으로 보여주도록 고쳤지만(client-access-values.ts), 애초에
  // 만들지 않는 편이 낫다 — 받는 시스템도 role 클레임 없이 들어온 사람을
  // 어떻게 다룰지 정해 두지 않았다.
  //
  // 역할을 쓰지 않는 시스템(available_roles가 빈 배열)은 그대로 role NULL로
  // 넣는다. 그쪽에서는 그것이 정상이고 화면도 「권한 있음」이라고 부른다.
  if (!roleArg && client.availableRoles.length > 0) {
    console.error(`"${client.name}" 은(는) 역할을 쓰는 시스템입니다.`);
    console.error("  역할 없이 부여할 수 없습니다 — 함께 지정하세요:");
    console.error(`     --role <${client.availableRoles.join("|")}>`);
    process.exitCode = 1;
    return;
  }

  const [inserted] = await db
    .insert(userClientGrants)
    .values({
      userId: target.id,
      clientId: client.id,
      role: roleArg ?? null,
      grantedBy: actor.id,
    })
    .returning({ id: userClientGrants.id });

  await audit({
    actorUserId: actor.id,
    actionType: "GRANT_ADDED",
    targetEntity: "user_client_grants",
    targetRecordId: inserted.id,
    newValue: {
      userId: target.id,
      displayName: target.displayName,
      role: roleArg ?? null,
    },
    clientId: client.clientId,
  });

  const grantedRole = roleArg ? ` (역할 ${roleArg})` : "";
  console.log(
    `${target.displayName} 에게 "${client.name}" 접근 권한을 부여했습니다.${grantedRole}`
  );

  if (!client.requiresGrant) {
    console.log("");
    console.log(`  참고: "${client.name}" 은(는) 전 직원 공개로 설정되어 있어`);
    console.log("  이 권한이 없어도 들어갈 수 있습니다. 기록은 남습니다.");
  }

  if (!client.isActive) {
    console.log("");
    console.log(`  참고: "${client.name}" 은(는) 비활성 상태라 지금은 로그인할 수 없습니다.`);
  }

  if (target.status !== "ACTIVE") {
    console.log("");
    console.log(`  참고: ${target.displayName} 의 계정 상태가 ${target.status} 입니다.`);
    console.log("  승인(ACTIVE)되기 전까지는 이 권한이 있어도 들어갈 수 없습니다.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
