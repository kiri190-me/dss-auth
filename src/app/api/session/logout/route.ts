import { secureCookiesEnabled } from "@/lib/config/env";
import { appendAuditLog } from "@/lib/db/mutations/audit";
import { clientIp, redirectTo } from "@/lib/http/redirect";
import {
  readSsoSession,
  revokeSsoSession,
  SSO_COOKIE_NAME,
} from "@/lib/session/sso-session";

/**
 * 로그아웃.
 *
 * POST만 받는다. GET으로 두면 <img src="/api/session/logout">만으로 남을
 * 로그아웃시킬 수 있다.
 *
 * 별도 CSRF 토큰을 두지 않은 근거: 세션 쿠키가 SameSite=Lax라 다른 사이트에서
 * 보낸 POST에는 쿠키 자체가 실리지 않는다. 쿠키가 없으면 readSsoSession이
 * null을 돌려주고 아무것도 폐기되지 않는다.
 *
 * **쿠키만 지우지 않고 DB에도 폐기 표시를 한다.** 쿠키 삭제는 브라우저에게
 * 부탁하는 것일 뿐이고, 이미 복사된 토큰은 그대로 살아 있다.
 */
export async function POST(request: Request) {
  const session = await readSsoSession();

  if (session) {
    await revokeSsoSession(session.sessionId);
    await appendAuditLog({
      actorUserId: session.userId,
      actionType: "LOGOUT",
      targetEntity: "sso_sessions",
      targetRecordId: session.sessionId,
      sourceIp: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
  }

  const response = redirectTo("/signin");
  response.cookies.set(SSO_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookiesEnabled(),
    path: "/",
    maxAge: 0,
  });
  return response;
}
