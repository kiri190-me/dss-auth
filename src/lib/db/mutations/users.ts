import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { identities, users } from "@/lib/db/schema";
import type { UserRow } from "@/lib/db/queries/users";

/**
 * 카카오 로그인으로 처음 들어온 사람을 승인 대기(PENDING) 상태로 만든다.
 *
 * 왜 자동으로 만드는가: 카카오 로그인 버튼은 전 세계 누구나 누를 수 있으므로
 * 여기서 만들어지는 행은 "접근 권한"이 아니라 "승인 신청서"에 가깝다.
 * PENDING 상태로는 어떤 시스템에도 들어갈 수 없고, 관리자가 실명·소속을
 * 채우고 승인해야 ACTIVE가 된다.
 *
 * 사용자와 신원을 한 트랜잭션으로 만든다 — 사용자만 만들어지고 신원 연결이
 * 실패하면 다음 로그인 때 또 다른 사용자가 생겨 중복이 쌓인다.
 */
export async function createPendingUserWithIdentity(params: {
  provider: (typeof identities.provider.enumValues)[number];
  providerSubject: string;
  displayName: string;
}): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        // 카카오 닉네임이 없으면 자리표시자를 둔다. 어차피 관리자가 승인하며
        // 실명으로 고치는 값이고, notNull 제약을 우회하려고 빈 문자열을
        // 넣으면 관리자 화면에서 빈 줄로 보여 더 헷갈린다.
        displayName: params.displayName || "(이름 미확인)",
        status: "PENDING",
      })
      .returning({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        department: users.department,
        status: users.status,
        isPortalAdmin: users.isPortalAdmin,
      });

    await tx.insert(identities).values({
      userId: created.id,
      provider: params.provider,
      providerSubject: params.providerSubject,
    });

    return created;
  });
}

export async function touchLastLogin(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}
