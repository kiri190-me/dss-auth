/**
 * 최초 포털 관리자 승격 스크립트.
 *
 * 왜 필요한가: 사용자를 승인하려면 관리자가 있어야 하는데, 첫 관리자를
 * 승인해 줄 사람이 아직 없다. 이 닭과 달걀을 끊는 유일한 통로다.
 *
 * 그래서 **서버에 접근할 수 있는 사람만** 쓸 수 있도록 웹 화면이 아니라
 * 스크립트로 둔다. 웹에 "첫 관리자 만들기" 화면을 두면 그 화면이 계속 남아
 * 공격 표면이 된다.
 *
 * 사용법:
 *   npm run admin:promote                 → 사용자 목록 출력
 *   npm run admin:promote -- <사용자 id>   → ACTIVE + 포털 관리자로 승격
 */
// 환경변수는 node --env-file=.env.local 로 주입한다(package.json 스크립트 참조).
// dotenv.config()를 파일 상단에 두는 방식은 동작하지 않는다 — ESM import는
// 호이스팅되어 dotenv보다 먼저 실행되므로, DB 모듈이 이미 빈 환경변수를 읽은 뒤다.
import { eq } from "drizzle-orm";
import { db, pgClient } from "../src/lib/db/connection";
import { auditLogs, users } from "../src/lib/db/schema";

async function main() {
  const target = process.argv[2];

  if (!target) {
    const rows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        status: users.status,
        isPortalAdmin: users.isPortalAdmin,
      })
      .from(users);

    if (rows.length === 0) {
      console.log("사용자가 없습니다. 먼저 카카오 로그인을 한 번 하세요.");
      return;
    }

    console.log("등록된 사용자:\n");
    for (const row of rows) {
      const badge = row.isPortalAdmin ? " [포털 관리자]" : "";
      console.log(`  ${row.id}  ${row.displayName}  (${row.status})${badge}`);
    }
    console.log("\n승격하려면:  npm run admin:promote -- <위의 id>");
    return;
  }

  const [before] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      status: users.status,
      isPortalAdmin: users.isPortalAdmin,
    })
    .from(users)
    .where(eq(users.id, target))
    .limit(1);

  if (!before) {
    console.error(`id가 "${target}"인 사용자를 찾을 수 없습니다.`);
    process.exitCode = 1;
    return;
  }

  if (before.status === "ACTIVE" && before.isPortalAdmin) {
    console.log(`${before.displayName}님은 이미 활성 포털 관리자입니다. 변경 없음.`);
    return;
  }

  const now = new Date();
  await db
    .update(users)
    .set({
      status: "ACTIVE",
      isPortalAdmin: true,
      approvedAt: now,
      // 자기 자신이 승인자다 — 최초 관리자는 승인해 줄 사람이 없다.
      approvedBy: before.id,
      updatedAt: now,
    })
    .where(eq(users.id, before.id));

  // 이 승격은 감사 로그에 반드시 남아야 한다. 서버 접근 권한만으로 권한이
  // 생기는 유일한 경로이므로, 나중에 "언제 누가 관리자가 됐는지" 추적 가능해야 한다.
  await db.insert(auditLogs).values({
    actorUserId: before.id,
    actionType: "USER_APPROVED",
    targetEntity: "users",
    targetRecordId: before.id,
    previousValue: { status: before.status, isPortalAdmin: before.isPortalAdmin },
    newValue: { status: "ACTIVE", isPortalAdmin: true, via: "promote-admin script" },
  });

  console.log(`${before.displayName}님을 활성 포털 관리자로 승격했습니다.`);
  console.log("브라우저를 새로고침하면 시스템 목록 화면으로 넘어갑니다.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
