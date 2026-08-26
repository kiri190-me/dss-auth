import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { sha256Hex } from "@/lib/crypto/hash";
import { randomToken } from "@/lib/crypto/random";
import { db } from "@/lib/db/client";
import { accessTokens } from "@/lib/db/schema";

/**
 * 액세스 토큰 수명 5분.
 *
 * 이 토큰의 유일한 용도는 /userinfo 한 번 호출이다. 로그인 직후 바로
 * 쓰이고 버려지므로 길게 잡을 이유가 없다.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 300;

/** 평문 토큰을 돌려준다. DB에는 sha256만 남는다. */
export async function issueAccessToken(input: {
  userId: string;
  clientId: string;
  scope: string;
}): Promise<string> {
  const token = randomToken(32);
  await db.insert(accessTokens).values({
    tokenHash: sha256Hex(token),
    userId: input.userId,
    clientId: input.clientId,
    scope: input.scope,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
  });
  return token;
}

export async function resolveAccessToken(token: string): Promise<{
  userId: string;
  clientId: string;
  scope: string;
} | null> {
  if (!token) return null;
  const [row] = await db
    .select({
      userId: accessTokens.userId,
      clientId: accessTokens.clientId,
      scope: accessTokens.scope,
    })
    .from(accessTokens)
    .where(
      and(
        eq(accessTokens.tokenHash, sha256Hex(token)),
        isNull(accessTokens.revokedAt),
        gt(accessTokens.expiresAt, new Date())
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * 특정 사용자·클라이언트 조합의 살아 있는 토큰을 전부 폐기한다.
 *
 * 인가 코드 재사용이 탐지됐을 때 부른다. 코드가 유출됐다면 그 코드로
 * 발급된 토큰도 공격자 손에 있다고 봐야 한다.
 *
 * SSO 세션까지 통째로 끊지는 않는다 — 브라우저 프리페치 같은 것으로
 * 오탐이 나면 정상 사용자가 튕겨 나가기 때문이다. 토큰 폐기와 경보까지가
 * 균형점이다.
 */
export async function revokeAccessTokensFor(
  userId: string,
  clientId: string
): Promise<number> {
  const revoked = await db
    .update(accessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(accessTokens.userId, userId),
        eq(accessTokens.clientId, clientId),
        isNull(accessTokens.revokedAt)
      )
    )
    .returning({ tokenHash: accessTokens.tokenHash });
  return revoked.length;
}
