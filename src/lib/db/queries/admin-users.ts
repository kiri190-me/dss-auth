import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { identities, users } from "@/lib/db/schema";

export type AdminUserRow = {
  id: string;
  displayName: string;
  email: string | null;
  employeeNo: string | null;
  department: string | null;
  status: (typeof users.status.enumValues)[number];
  isPortalAdmin: boolean;
  suspendReason: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** 연결된 로그인 수단. 예: "KAKAO" 또는 "EMERGENCY,KAKAO" */
  providers: string | null;
};

/**
 * 관리자 화면용 전체 사용자 목록.
 *
 * 승인 대기(PENDING)를 맨 위로 올린다 — 관리자가 이 화면을 여는 이유의
 * 대부분이 "새로 신청한 사람 승인"이기 때문이다. 스크롤해서 찾게 만들면
 * 승인이 늦어지고, 늦어지면 직원이 다른 경로를 찾게 된다.
 */
export async function listUsersForAdmin(): Promise<AdminUserRow[]> {
  return db
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      employeeNo: users.employeeNo,
      department: users.department,
      status: users.status,
      isPortalAdmin: users.isPortalAdmin,
      suspendReason: users.suspendReason,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      providers: sql<string | null>`string_agg(distinct ${identities.provider}::text, ',')`,
    })
    .from(users)
    // leftJoin이어야 한다. 신원이 아직 연결되지 않은 행도 관리자에게는
    // 보여야 한다 — 안 보이면 이상 상태를 발견할 방법이 없다.
    .leftJoin(identities, eq(identities.userId, users.id))
    .groupBy(users.id)
    .orderBy(
      sql`case ${users.status} when 'PENDING' then 0 when 'ACTIVE' then 1 else 2 end`,
      users.createdAt
    );
}
