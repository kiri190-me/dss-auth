/**
 * 비상 관리자 계정 생성 · 비밀번호 재발급 · 잠금 해제.
 *
 * 왜 필요한가: 포털에 들어오는 길이 카카오 하나뿐이면, 카카오가 죽거나
 * 관리자가 카카오 계정을 잃는 순간 아무도 포털을 관리할 수 없다. 통합
 * 로그인을 도입한 뒤로는 그것이 포털 하나로 끝나지 않는다 — 포털에 기대는
 * 모든 사내 시스템이 함께 잠긴다.
 *
 * 왜 웹 화면이 아니라 스크립트인가: promote-admin.ts와 같은 판단이다.
 * 웹에 "비상 계정 만들기" 화면을 두면 그 화면이 계속 남아 공격 표면이 된다.
 * 서버에 접근할 수 있는 사람만 만들 수 있어야 한다.
 *
 * 비밀번호를 인자로 받지 않는 이유: 셸 히스토리와 프로세스 목록에 평문이
 * 남는다. 이 스크립트가 강한 무작위 비밀번호를 만들어 한 번만 보여준다
 * (register-client.ts가 클라이언트 시크릿을 다루는 방식과 같다).
 *
 * 사용법:
 *   npm run admin:emergency
 *     → 등록된 비상 계정과 상태 출력
 *
 *   npm run admin:emergency -- --create <아이디> --name "이름"
 *     → 새 비상 계정을 만들고 비밀번호를 한 번 보여준다
 *
 *   npm run admin:emergency -- --reset <아이디>
 *     → 비밀번호만 새로 발급 (계정·감사 기록은 그대로)
 *
 *   npm run admin:emergency -- --unlock <아이디>
 *     → 실패 누적으로 걸린 잠금을 즉시 푼다
 */
// 환경변수는 node --env-file=.env.local 로 주입한다(package.json 스크립트 참조).
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "../src/lib/crypto/hash";
import { db, pgClient } from "../src/lib/db/connection";
import { auditLogs, identities, users } from "../src/lib/db/schema";

/**
 * 사람이 종이에 옮겨 적을 수 있어야 하므로 base64url을 쓰지 않는다.
 * 혼동하기 쉬운 글자(0/O, 1/l/I)를 뺀 32자 알파벳에서 20자를 뽑는다 —
 * 약 103비트로, scrypt 앞에서는 무차별 대입이 의미를 잃는다.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PASSWORD_LENGTH = 20;

function newPassword(): string {
  // 256을 32로 나누어떨어지게 하여 모듈로 편향을 없앤다.
  const bytes = randomBytes(PASSWORD_LENGTH);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out.replace(/(.{5})(?=.)/g, "$1-");
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function printPassword(loginId: string, password: string) {
  console.log("\n" + "─".repeat(64));
  console.log("  아래 비밀번호는 지금 한 번만 표시됩니다.");
  console.log("  DB에는 해시만 저장되므로 잃어버리면 재발급만 가능합니다.");
  console.log("─".repeat(64));
  console.log(`\n  아이디    ${loginId}`);
  console.log(`  비밀번호  ${password}\n`);
  console.log("─".repeat(64));
  console.log("  채팅·이메일로 보내지 말고 비밀번호 관리자나 금고에 넣으세요.");
  console.log("  카카오가 살아 있을 때 한 번 로그인해 보고 보관하세요 —");
  console.log("  정작 필요한 날 처음 써보면 늦습니다.");
  console.log("─".repeat(64) + "\n");
}

async function findIdentity(loginId: string) {
  const [row] = await db
    .select({
      identityId: identities.id,
      failedAttempts: identities.failedAttempts,
      lockedUntil: identities.lockedUntil,
      lastUsedAt: identities.lastUsedAt,
      userId: users.id,
      displayName: users.displayName,
      status: users.status,
      isPortalAdmin: users.isPortalAdmin,
    })
    .from(identities)
    .innerJoin(users, eq(identities.userId, users.id))
    .where(
      and(
        eq(identities.provider, "EMERGENCY"),
        eq(identities.providerSubject, loginId)
      )
    )
    .limit(1);
  return row;
}

async function list() {
  const rows = await db
    .select({
      loginId: identities.providerSubject,
      failedAttempts: identities.failedAttempts,
      lockedUntil: identities.lockedUntil,
      lastUsedAt: identities.lastUsedAt,
      displayName: users.displayName,
      status: users.status,
      isPortalAdmin: users.isPortalAdmin,
    })
    .from(identities)
    .innerJoin(users, eq(identities.userId, users.id))
    .where(eq(identities.provider, "EMERGENCY"));

  if (rows.length === 0) {
    console.log("비상 계정이 없습니다.");
    console.log("");
    console.log("  카카오가 죽으면 아무도 포털에 들어올 수 없는 상태입니다.");
    console.log("  하나 만들어 두세요:");
    console.log('    npm run admin:emergency -- --create <아이디> --name "이름"');
    return;
  }

  const now = new Date();
  console.log(`비상 계정 ${rows.length}건\n`);

  for (const row of rows) {
    const locked =
      row.lockedUntil && row.lockedUntil.getTime() > now.getTime()
        ? ` · 잠김(${Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 60000)}분 남음)`
        : "";
    const admin = row.isPortalAdmin ? "" : " · ⚠ 포털 관리자 아님";
    const used = row.lastUsedAt
      ? row.lastUsedAt.toISOString().slice(0, 16).replace("T", " ")
      : "쓴 적 없음";

    console.log(`  ${row.loginId}  (${row.displayName})`);
    console.log(`    ${row.status}${admin}${locked} · 마지막 사용 ${used}`);
    if (row.failedAttempts > 0) {
      console.log(`    연속 실패 ${row.failedAttempts}회`);
    }
  }
}

async function create(loginId: string) {
  const name = arg("name");
  if (!name) {
    console.error('--name "이름" 을 함께 주세요. 감사 로그에 사람 이름으로 남습니다.');
    process.exitCode = 1;
    return;
  }

  if (await findIdentity(loginId)) {
    console.error(`"${loginId}" 는 이미 있습니다.`);
    console.error("비밀번호를 새로 받으려면: --reset " + loginId);
    process.exitCode = 1;
    return;
  }

  const password = newPassword();

  // 사용자와 신원을 한 트랜잭션으로 만든다 — 사용자만 만들어지고 신원이
  // 실패하면 로그인할 수 없는 유령 계정이 남는다.
  // (createPendingUserWithIdentity와 같은 이유, 다만 이쪽은 처음부터
  //  ACTIVE + 포털 관리자다. 승인해 줄 사람이 없는 상황을 위한 계정이라
  //  PENDING으로 만들면 존재 이유가 사라진다.)
  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        displayName: name,
        status: "ACTIVE",
        isPortalAdmin: true,
        approvedAt: new Date(),
      })
      .returning({ id: users.id });

    await tx.insert(identities).values({
      userId: user.id,
      provider: "EMERGENCY",
      providerSubject: loginId,
      passwordHash: hashPassword(password),
    });

    return user;
  });

  await db.insert(auditLogs).values({
    actorUserId: created.id,
    actionType: "USER_CREATED",
    targetEntity: "users",
    targetRecordId: created.id,
    newValue: { via: "EMERGENCY", loginId, displayName: name },
  });

  console.log(`비상 계정 "${loginId}" 를 만들었습니다. (${name} · 포털 관리자)`);
  printPassword(loginId, password);
}

async function reset(loginId: string) {
  const row = await findIdentity(loginId);
  if (!row) {
    console.error(`"${loginId}" 라는 비상 계정이 없습니다.`);
    process.exitCode = 1;
    return;
  }

  const password = newPassword();
  await db
    .update(identities)
    .set({
      passwordHash: hashPassword(password),
      // 재발급은 잠금 해제를 겸한다. 비밀번호를 잊어 잠긴 경우가 대부분이라
      // 두 명령을 따로 치게 하면 그 순간에 한 번 더 막힌다.
      failedAttempts: 0,
      lockedUntil: null,
    })
    .where(eq(identities.id, row.identityId));

  await db.insert(auditLogs).values({
    actorUserId: row.userId,
    actionType: "USER_UPDATED",
    targetEntity: "identities",
    targetRecordId: row.identityId,
    newValue: { via: "EMERGENCY", action: "PASSWORD_RESET", loginId },
  });

  console.log(`"${loginId}" 의 비밀번호를 새로 발급했습니다. 잠금도 함께 풀렸습니다.`);
  printPassword(loginId, password);
}

async function unlock(loginId: string) {
  const row = await findIdentity(loginId);
  if (!row) {
    console.error(`"${loginId}" 라는 비상 계정이 없습니다.`);
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const wasLocked = row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime();

  if (!wasLocked && row.failedAttempts === 0) {
    console.log(`"${loginId}" 는 잠겨 있지 않습니다.`);
    return;
  }

  await db
    .update(identities)
    .set({ failedAttempts: 0, lockedUntil: null })
    .where(eq(identities.id, row.identityId));

  await db.insert(auditLogs).values({
    actorUserId: row.userId,
    actionType: "USER_UPDATED",
    targetEntity: "identities",
    targetRecordId: row.identityId,
    previousValue: {
      failedAttempts: row.failedAttempts,
      lockedUntil: row.lockedUntil?.toISOString() ?? null,
    },
    newValue: { via: "EMERGENCY", action: "UNLOCK", loginId },
  });

  console.log(`"${loginId}" 의 잠금을 풀었습니다.`);
}

async function main() {
  const createId = arg("create");
  const resetId = arg("reset");
  const unlockId = arg("unlock");

  if (createId) return create(createId);
  if (resetId) return reset(resetId);
  if (unlockId) return unlock(unlockId);

  await list();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
