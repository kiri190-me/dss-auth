import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "@/lib/crypto/hash";
import { verifyTotp } from "@/lib/crypto/totp";
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
  /** 비밀번호는 맞았지만 인증 코드가 없거나 틀렸다. */
  | { outcome: "REJECTED"; code: "TOTP_REQUIRED" | "TOTP_INVALID" }
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
 *
 * 해시가 아니라 **Promise를 담아 둔다.** 동시에 두 요청이 들어와도 계산은
 * 한 번만 돌고 둘 다 같은 결과를 기다린다 — 해시를 담으면 첫 계산이 끝나기
 * 전에 온 요청이 각자 새로 계산해, 없는 아이디로 두드릴수록 비용이 늘어난다.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString("base64"));
  return dummyHashPromise;
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
  password: string,
  /** 인증 앱의 6자리 코드. 2단계 인증을 켠 계정에서만 쓰인다. */
  totpCodeInput?: string
): Promise<EmergencyLoginResult> {
  const trimmed = loginId.trim();

  const [row] = await db
    .select({
      identityId: identities.id,
      passwordHash: identities.passwordHash,
      failedAttempts: identities.failedAttempts,
      lockedUntil: identities.lockedUntil,
      totpSecret: identities.totpSecret,
      totpConfirmedAt: identities.totpConfirmedAt,
      totpLastStep: identities.totpLastStep,
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
    await verifyPassword(password, await getDummyHash());
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

  if (!(await verifyPassword(password, row.passwordHash))) {
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

  // ── 2단계 인증 ──
  //
  // 비밀번호가 맞은 뒤에만 본다. 순서를 바꾸면 코드가 틀렸다는 응답만으로
  // "이 아이디는 존재하고 2단계 인증이 켜져 있다"가 새어 나간다.
  //
  // totpConfirmedAt이 있을 때만 요구한다. 비밀키를 만들어 두기만 하고 아직
  // 인증 앱으로 확인하지 않은 상태에서 요구하면, 잘못 옮겨 적은 사람이 그
  // 즉시 비상 계정에서 잠긴다 — 하필 모든 것이 고장났을 때 쓰는 계정이다.
  const totpRequired = row.totpConfirmedAt !== null && row.totpSecret !== null;

  if (totpRequired) {
    const code = (totpCodeInput ?? "").trim();
    if (code === "") {
      // 실패로 세지 않는다. 코드 칸을 비워 보낸 것은 틀린 시도가 아니라
      // 아직 안 낸 것이고, 이것으로 잠그면 화면이 코드를 물어보기도 전에
      // 계정이 잠긴다.
      return { outcome: "REJECTED", code: "TOTP_REQUIRED" };
    }

    const verified = verifyTotp({
      secret: row.totpSecret!,
      code,
      now: Math.floor(now.getTime() / 1000),
      lastUsedStep: row.totpLastStep,
    });

    if (!verified.ok) {
      // 비밀번호 실패와 같은 잠금을 쓴다. 두 자물쇠를 따로 세면 각각 5번씩
      // 열 번을 시도할 수 있게 된다.
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
      return { outcome: "REJECTED", code: "TOTP_INVALID" };
    }

    // 통과한 칸을 적어 둔다 — 같은 코드가 30초 안에 다시 쓰이는 것을 막는다.
    await db
      .update(identities)
      .set({ ...CLEARED_LOCK_STATE, lastUsedAt: now, totpLastStep: verified.step })
      .where(eq(identities.id, row.identityId));
  } else {
    // 비밀번호는 맞았다. 계정 상태와 무관하게 실패 기록은 지운다 — 상태 때문에
    // 막힌 것을 실패 누적으로 잠그면 상태를 고친 뒤에도 못 들어온다.
    await db
      .update(identities)
      .set({ ...CLEARED_LOCK_STATE, lastUsedAt: now })
      .where(eq(identities.id, row.identityId));
  }

  if (row.status !== "ACTIVE") {
    return { outcome: "REJECTED", code: "NOT_ACTIVE" };
  }

  return {
    outcome: "SESSION",
    userId: row.userId,
    displayName: row.displayName,
  };
}
