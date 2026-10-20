import { secureCookiesEnabled } from "@/lib/config/env";
import { appendAuditLog } from "@/lib/db/mutations/audit";
import { clearDismissals } from "@/lib/db/mutations/notification-dismissals";
import { notifyBackchannelLogout } from "@/lib/oidc/backchannel-logout";
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

    // 지운 알림 표시를 비운다 — api/oidc/logout과 같은 일이다(설계안 3-6).
    //
    // 🔴 **설계안이 빠뜨린 자리다.** 3-6은 api/oidc/logout 한 곳만 적었는데,
    // 세션을 폐기하는 라우트는 그곳과 여기 둘이다(이쪽은 포털 화면의 로그아웃
    // 단추). 한쪽만 고치면 포털 화면에서 로그아웃한 사람은 지움 기록이 남아,
    // 다시 로그인해도 지웠던 알림이 계속 안 보인다 — 증상이 「내 알림만 안
    // 뜬다」라서 원인을 찾기 어렵다.
    //
    // 자리와 실패 처리의 까닭은 api/oidc/logout/route.ts와 같다: 되돌아오지
    // 못할 세션 폐기·감사 기록을 먼저 끝내고(지움 정리는 못 해도 하루 뒤
    // 보관 기간이 덮는다), 포털 제 DB 일을 여기까지 묶은 뒤 느린 네트워크
    // 호출인 백채널 통보를 마지막에 둔다. 실패해도 로그아웃은 끝까지 간다 —
    // db/mutations/audit.ts와 아래 notifyBackchannelLogout이 이미 같은 판단을
    // 해 두었다.
    try {
      await clearDismissals(session.userId);
    } catch (error) {
      console.error(
        "[logout] 알림 지움 기록 정리 실패:",
        session.userId,
        error
      );
    }

    // 각 시스템에도 알린다. 우리 쿠키만 지우면 각 시스템이 발급한 자기
    // 쿠키는 그대로 살아 있다. 실패해도 로그아웃 자체는 진행한다.
    await notifyBackchannelLogout({
      userId: session.userId,
      sessionId: session.sessionId,
      reason: "LOGOUT",
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
