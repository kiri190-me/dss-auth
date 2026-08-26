import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { identities, users } from "@/lib/db/schema";

export type UserRow = {
  id: string;
  displayName: string;
  email: string | null;
  department: string | null;
  status: (typeof users.status.enumValues)[number];
  isPortalAdmin: boolean;
};

const USER_COLUMNS = {
  id: users.id,
  displayName: users.displayName,
  email: users.email,
  department: users.department,
  status: users.status,
  isPortalAdmin: users.isPortalAdmin,
} as const;

export async function getUserById(id: string): Promise<UserRow | null> {
  const [row] = await db.select(USER_COLUMNS).from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

/**
 * 외부 신원(카카오 회원번호 등)으로 사원을 찾는다.
 *
 * 이메일로 찾지 않는 이유: 카카오 계정 이메일은 사용자가 바꿀 수 있어
 * 신원의 기준이 될 수 없다. 기준은 항상 provider + providerSubject다.
 */
export async function getUserByIdentity(
  provider: (typeof identities.provider.enumValues)[number],
  providerSubject: string
): Promise<UserRow | null> {
  const [row] = await db
    .select(USER_COLUMNS)
    .from(identities)
    .innerJoin(users, eq(identities.userId, users.id))
    .where(
      and(
        eq(identities.provider, provider),
        eq(identities.providerSubject, providerSubject)
      )
    )
    .limit(1);
  // 컬럼을 명시적으로 고른 select는 조인이어도 테이블별로 중첩되지 않고
  // 평평한 형태로 온다.
  return row ?? null;
}
