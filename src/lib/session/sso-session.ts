import "server-only";
import { cookies } from "next/headers";
import { and, eq, gt, isNull } from "drizzle-orm";
import { secureCookiesEnabled } from "@/lib/config/env";
import { sha256Hex } from "@/lib/crypto/hash";
import { randomToken } from "@/lib/crypto/random";
import { db } from "@/lib/db/client";
import { identities, ssoSessions, users } from "@/lib/db/schema";

export const SSO_COOKIE_NAME = "dss_sso";

/**
 * 절대 만료 12시간. 활동 중이어도 이 시점이 지나면 다시 로그인해야 한다.
 * 업무 시작부터 종료까지 한 번의 로그인으로 덮으면서, 퇴근 후 방치된
 * 브라우저가 밤새 열려 있지 않도록 하는 균형점이다.
 */
export const SSO_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/**
 * 쿠키 속성.
 *
 * - httpOnly: 자바스크립트가 못 읽는다(XSS로 세션을 훔쳐가지 못하게).
 * - sameSite lax: SSO 리다이렉트는 최상위 GET 탐색이라 lax로 충분히 실린다.
 *   none을 쓰면 secure가 강제되어 사내망 HTTP 단계에서 아예 깨진다.
 * - secure: issuer가 https일 때만. HTTP 단계에서 켜면 쿠키가 저장되지 않아
 *   로그인이 조용히 실패한다.
 */
export function ssoCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secureCookiesEnabled(),
    path: "/",
    maxAge: SSO_SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * 세션을 만들고 브라우저에 심을 토큰을 돌려준다.
 *
 * 쿠키에는 32바이트 랜덤 원문이 들어가고 DB에는 그 sha256만 저장한다.
 * DB 덤프가 유출되어도 살아 있는 세션을 그대로 탈취당하지 않는다.
 *
 * 쿠키를 여기서 직접 심지 않고 토큰만 돌려주는 이유: 로그인 직후는 대개
 * 리다이렉트 응답이라, 그 응답 객체에 쿠키를 붙이는 편이 확실하다.
 */
export async function createSsoSession(params: {
  userId: string;
  authMethod: (typeof identities.provider.enumValues)[number];
  userAgent?: string | null;
  sourceIp?: string | null;
}): Promise<{ token: string; sessionId: string }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SSO_SESSION_MAX_AGE_SECONDS * 1000);

  const [row] = await db
    .insert(ssoSessions)
    .values({
      userId: params.userId,
      tokenHash: sha256Hex(token),
      authMethod: params.authMethod,
      expiresAt,
      userAgent: params.userAgent ?? null,
      sourceIp: params.sourceIp ?? null,
    })
    .returning({ id: ssoSessions.id });

  return { token, sessionId: row.id };
}

export type SsoSessionUser = {
  sessionId: string;
  userId: string;
  displayName: string;
  email: string | null;
  status: (typeof users.status.enumValues)[number];
  isPortalAdmin: boolean;
  /** 실제로 카카오 인증을 통과한 시각. ID 토큰의 auth_time 클레임이 된다. */
  authTime: Date;
};

/**
 * 쿠키에서 현재 세션을 푼다.
 *
 * 매번 DB를 다시 읽는다. 사용자 상태를 세션에 캐시하지 않는 것이 핵심이다 —
 * 관리자가 누군가를 정지시키면 12시간을 기다리지 않고 **다음 요청부터** 막혀야
 * 한다. (A/S 시스템의 acting-user.ts가 같은 이유로 매 요청 DB를 재조회한다.)
 *
 * 어떤 이유로든 유효하지 않으면 null이다. 예외를 호출자에게 던지지 않는다.
 */
export async function readSsoSession(): Promise<SsoSessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SSO_COOKIE_NAME)?.value;
  if (!token) return null;

  const [row] = await db
    .select({
      sessionId: ssoSessions.id,
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      status: users.status,
      isPortalAdmin: users.isPortalAdmin,
      authTime: ssoSessions.authTime,
    })
    .from(ssoSessions)
    .innerJoin(users, eq(ssoSessions.userId, users.id))
    .where(
      and(
        eq(ssoSessions.tokenHash, sha256Hex(token)),
        isNull(ssoSessions.revokedAt),
        gt(ssoSessions.expiresAt, new Date())
      )
    )
    .limit(1);

  return row ?? null;
}

/** 로그아웃. 되돌릴 수 없도록 DB에 표시한다(쿠키만 지우면 회수가 아니다). */
export async function revokeSsoSession(sessionId: string): Promise<void> {
  await db
    .update(ssoSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(ssoSessions.id, sessionId), isNull(ssoSessions.revokedAt)));
}
