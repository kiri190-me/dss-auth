import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { sha256Hex } from "@/lib/crypto/hash";
import { randomToken } from "@/lib/crypto/random";
import { db } from "@/lib/db/client";
import { authorizationCodes } from "@/lib/db/schema";

/**
 * 인가 코드 수명 60초.
 *
 * 코드는 브라우저 주소창을 거쳐 클라이언트 서버로 가고, 곧바로 토큰으로
 * 교환된다. 그 왕복에 60초면 넉넉하다. 길게 잡을수록 프록시 로그·브라우저
 * 히스토리·Referer에 남은 코드가 살아 있는 시간만 늘어난다.
 */
const CODE_TTL_SECONDS = 60;

export type IssueCodeInput = {
  clientId: string;
  userId: string;
  ssoSessionId: string;
  redirectUri: string;
  scope: string;
  nonce: string;
  codeChallenge: string;
  authTime: Date;
};

/** 평문 코드를 돌려준다. DB에는 sha256만 남는다. */
export async function issueAuthorizationCode(input: IssueCodeInput): Promise<string> {
  const code = randomToken(32);
  await db.insert(authorizationCodes).values({
    codeHash: sha256Hex(code),
    clientId: input.clientId,
    userId: input.userId,
    ssoSessionId: input.ssoSessionId,
    redirectUri: input.redirectUri,
    scope: input.scope,
    nonce: input.nonce,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: "S256",
    authTime: input.authTime,
    expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
  });
  return code;
}

export type ConsumedCode = {
  clientId: string;
  userId: string;
  ssoSessionId: string;
  redirectUri: string;
  scope: string;
  nonce: string;
  codeChallenge: string;
  authTime: Date;
};

/**
 * 코드를 1회 소비한다.
 *
 * ⚠️ **반드시 SQL 한 문장이어야 한다.** "조회 → 검사 → 소비 표시"로 나누면,
 * 동시에 도착한 두 요청이 같은 코드로 둘 다 토큰을 받는 경합이 생긴다.
 * UPDATE ... WHERE consumed_at IS NULL 은 원자적이라, 둘 중 하나만 행을
 * 돌려받는다.
 *
 * null은 "없음 / 이미 소비됨 / 만료됨"을 구분하지 않는다. 호출자에게
 * 구분해 알려줄 이유가 없다 — 어차피 전부 invalid_grant다.
 */
export async function consumeAuthorizationCode(code: string): Promise<ConsumedCode | null> {
  const [row] = await db
    .update(authorizationCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authorizationCodes.codeHash, sha256Hex(code)),
        isNull(authorizationCodes.consumedAt),
        gt(authorizationCodes.expiresAt, new Date())
      )
    )
    .returning({
      clientId: authorizationCodes.clientId,
      userId: authorizationCodes.userId,
      ssoSessionId: authorizationCodes.ssoSessionId,
      redirectUri: authorizationCodes.redirectUri,
      scope: authorizationCodes.scope,
      nonce: authorizationCodes.nonce,
      codeChallenge: authorizationCodes.codeChallenge,
      authTime: authorizationCodes.authTime,
    });
  return row ?? null;
}

/**
 * 소비 실패가 "이미 쓴 코드를 다시 들이민 것"인지 확인한다.
 *
 * 단순 만료나 오타와 달리, 이미 소비된 코드가 다시 오는 것은 **코드가
 * 유출됐다는 신호**다. 정상 클라이언트는 코드를 한 번만 쓴다.
 * consumed_at을 지우지 않고 남겨두는 이유가 이 판별을 위해서다.
 */
export async function wasCodeAlreadyConsumed(code: string): Promise<{
  clientId: string;
  userId: string;
} | null> {
  const [row] = await db
    .select({
      clientId: authorizationCodes.clientId,
      userId: authorizationCodes.userId,
      consumedAt: authorizationCodes.consumedAt,
    })
    .from(authorizationCodes)
    .where(eq(authorizationCodes.codeHash, sha256Hex(code)))
    .limit(1);
  if (!row || row.consumedAt === null) return null;
  return { clientId: row.clientId, userId: row.userId };
}
