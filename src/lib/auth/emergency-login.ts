import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "@/lib/crypto/hash";
import { db } from "@/lib/db/client";
import { identities, users } from "@/lib/db/schema";
import {
  afterFailure,
  CLEARED_LOCK_STATE,
  isLocked,
  minutesUntilUnlock,
  type LockState,
} from "./emergency-lockout";

export type EmergencyLoginResult =
  | { outcome: "SESSION"; userId: string; displayName: string }
  | { outcome: "REJECTED"; code: "INVALID" | "NOT_ACTIVE" }
  | { outcome: "REJECTED"; code: "LOCKED"; minutesRemaining: number };

/**
 * 존재하지 않는 아이디에도 검증 시간을 맞추기 위한 더미 해시.
 *
 * scrypt는 일부러 느리다(수십 ms). 아이디가 없을 때 곧바로 돌려주면 응답
 * 시간만으로 "이 아이디는 존재한다"가 새어 나간다. 실제 검증과 같은 일을
 * 한 번 시켜 시간을 맞춘다.
 *
 * 첫 호출 때 한 번만 만든다 — 모듈 최상단에서 만들면 이 파일을 import하는
 * 모든 요청 경로가 서버 시작 시 scrypt 한 번을 떠안는다.
 */
let dummyHash: string | null = null;
function getDummyHash(): string {
  dummyHash ??= hashPassword(randomBytes(32).toString("base64"));
  return dummyHash;
}

/**
 * 비상 계정 로그인 판정.
 *
 * 카카오를 거치지 않는 유일한 통로다. 카카오가 죽거나 관리자가 카카오
 * 계정을 잃어도 포털에 들어올 수 있어야 한다 — 통합 로그인을 도입한 뒤로는
 * 포털이 막히면 이 포털에 기대는 모든 시스템이 함께 막히기 때문이다.
 *
 * 계정을 만들지 않는다. 비상 계정은 서버에 접근할 수 있는 사람이
 * admin:emergency 스크립트로만 만든다 — 웹에 만드는 화면을 두면 그 화면이
 * 영구적인 공격 표면이 된다(promote-admin.ts와 같은 판단이다).
 */
export async function resolveEmergencyLogin(
  loginId: string,
  password: string
): Promise<EmergencyLoginResult> {
  const trimmed = loginId.trim();

  const [row] = await db
    .select({
      identityId: identities.id,
      passwordHash: identities.passwordHash,
      failedAttempts: identities.failedAttempts,
      lockedUntil: identities.lockedUntil,
      userId: users.id,
      displayName: users.displayName,
      status: users.status,
    })
    .from(identities)
    .innerJoin(users, eq(identities.userId, users.id))
    .where(
      and(
        eq(identities.provider, "EMERGENCY"),
        eq(identities.providerSubject, trimmed)
      )
    )
    .limit(1);

  // 아이디가 없거나 비밀번호가 설정되지 않은 신원도 여기서 함께 처리한다.
  if (!row || !row.passwordHash) {
    verifyPassword(password, getDummyHash());
    return { outcome: "REJECTED", code: "INVALID" };
  }

  const now = new Date();
  const state: LockState = {
    failedAttempts: row.failedAttempts,
    lockedUntil: row.lockedUntil,
  };

  if (isLocked(state, now)) {
    // 잠긴 동안에는 비밀번호를 아예 보지 않는다. 맞는 비밀번호로도 잠금을
    // 풀 수 없어야 잠금이 의미가 있다.
    return {
      outcome: "REJECTED",
      code: "LOCKED",
      minutesRemaining: minutesUntilUnlock(state, now),
    };
  }

  if (!verifyPassword(password, row.passwordHash)) {
    const next = afterFailure(state, now);
    await db
      .update(identities)
      .set({ failedAttempts: next.failedAttempts, lockedUntil: next.lockedUntil })
      .where(eq(identities.id, row.identityId));

    if (isLocked(next, now)) {
      return {
        outcome: "REJECTED",
        code: "LOCKED",
        minutesRemaining: minutesUntilUnlock(next, now),
      };
    }
    return { outcome: "REJECTED", code: "INVALID" };
  }

  // 비밀번호는 맞았다. 계정 상태와 무관하게 실패 기록은 지운다 — 상태 때문에
  // 막힌 것을 실패 누적으로 잠그면 상태를 고친 뒤에도 못 들어온다.
  await db
    .update(identities)
    .set({ ...CLEARED_LOCK_STATE, lastUsedAt: now })
    .where(eq(identities.id, row.identityId));

  if (row.status !== "ACTIVE") {
    return { outcome: "REJECTED", code: "NOT_ACTIVE" };
  }

  return {
    outcome: "SESSION",
    userId: row.userId,
    displayName: row.displayName,
  };
}
