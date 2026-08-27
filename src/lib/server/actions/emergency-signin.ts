"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveEmergencyLogin } from "@/lib/auth/emergency-login";
import { appendAuditLog } from "@/lib/db/mutations/audit";
import { touchLastLogin } from "@/lib/db/mutations/users";
import { sanitizeReturnTo } from "@/lib/session/login-tx";
import {
  createSsoSession,
  ssoCookieOptions,
  SSO_COOKIE_NAME,
} from "@/lib/session/sso-session";

const EMERGENCY_PATH = "/signin/emergency";

/**
 * 비상 계정 로그인.
 *
 * 서버 액션으로 둔 이유: Next가 서버 액션 호출마다 Origin과 Host를 대조해
 * 거절하므로(next/dist/docs 01-app/02-guides/server-actions.md "Security"),
 * CSRF 토큰을 손으로 만들 필요가 없다. 라우트 핸들러로 만들었다면 그 방어를
 * 직접 짜야 했다 — 카카오 시작 링크가 GET이라 CSRF가 필요 없었던 것과 달리,
 * 이쪽은 비밀번호를 받는 POST다.
 */
export async function emergencySignIn(formData: FormData): Promise<void> {
  const loginId = String(formData.get("loginId") ?? "");
  const password = String(formData.get("password") ?? "");
  const returnTo = sanitizeReturnTo(String(formData.get("returnTo") ?? "") || null);

  const headerList = await headers();
  const sourceIp = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const userAgent = headerList.get("user-agent");

  if (!loginId || !password) {
    redirect(`${EMERGENCY_PATH}?error=invalid`);
  }

  const result = await resolveEmergencyLogin(loginId, password);

  if (result.outcome === "REJECTED") {
    await appendAuditLog({
      actionType: "LOGIN_FAILED",
      // 행위자를 남기지 않는다 — 아이디가 맞았는지조차 이 시점에는 밝히지
      // 않는 편이 낫고, 애초에 아이디가 없으면 가리킬 사용자도 없다.
      newValue: { reason: result.code, via: "EMERGENCY", loginId },
      sourceIp,
      userAgent,
    });

    const query =
      result.code === "LOCKED"
        ? `error=locked&minutes=${result.minutesRemaining}`
        : `error=${result.code === "NOT_ACTIVE" ? "not_active" : "invalid"}`;
    redirect(`${EMERGENCY_PATH}?${query}`);
  }

  const { token, sessionId } = await createSsoSession({
    userId: result.userId,
    authMethod: "EMERGENCY",
    userAgent,
    sourceIp,
  });
  await touchLastLogin(result.userId);

  await appendAuditLog({
    actorUserId: result.userId,
    actionType: "EMERGENCY_LOGIN",
    targetEntity: "sso_sessions",
    targetRecordId: sessionId,
    newValue: { displayName: result.displayName },
    sourceIp,
    userAgent,
  });

  (await cookies()).set(SSO_COOKIE_NAME, token, ssoCookieOptions());

  redirect(returnTo ?? "/apps");
}
