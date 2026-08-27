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
 * 거절 사유를 주소창의 값으로 옮긴다.
 *
 * TOTP_REQUIRED와 TOTP_INVALID를 따로 두는 이유: 둘 다 "코드를 다시 내라"로
 * 끝나지만, 앞의 것은 아직 안 낸 것이고 뒤의 것은 실패로 세어진 것이다.
 * 화면이 그 차이를 말해 주지 않으면 사람은 자기가 몇 번 남았는지 모른다.
 *
 * 두 값 모두 비밀번호가 맞았다는 사실을 드러낸다. 그래도 괜찮은 이유는
 * 이 지점에 닿으려면 이미 비밀번호를 알아야 하기 때문이다 — 모르는 사람에게
 * 새는 정보가 아니다.
 */
function rejectionQuery(result: {
  code: string;
  minutesRemaining?: number;
}): string {
  switch (result.code) {
    case "LOCKED":
      return `error=locked&minutes=${result.minutesRemaining}`;
    case "NOT_ACTIVE":
      return "error=not_active";
    case "TOTP_REQUIRED":
      return "error=totp_required";
    case "TOTP_INVALID":
      return "error=totp_invalid";
    default:
      return "error=invalid";
  }
}

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
  const totpCode = String(formData.get("totpCode") ?? "");
  const returnTo = sanitizeReturnTo(String(formData.get("returnTo") ?? "") || null);

  const headerList = await headers();
  const sourceIp = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const userAgent = headerList.get("user-agent");

  if (!loginId || !password) {
    redirect(`${EMERGENCY_PATH}?error=invalid`);
  }

  const result = await resolveEmergencyLogin(loginId, password, totpCode);

  if (result.outcome === "REJECTED") {
    await appendAuditLog({
      actionType: "LOGIN_FAILED",
      // 행위자를 남기지 않는다 — 아이디가 맞았는지조차 이 시점에는 밝히지
      // 않는 편이 낫고, 애초에 아이디가 없으면 가리킬 사용자도 없다.
      newValue: { reason: result.code, via: "EMERGENCY", loginId },
      sourceIp,
      userAgent,
    });

    redirect(`${EMERGENCY_PATH}?${rejectionQuery(result)}`);
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
