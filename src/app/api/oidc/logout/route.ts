import type { NextRequest } from "next/server";
import { decodeJwt } from "jose";
import { allowHttpRedirectUris, secureCookiesEnabled } from "@/lib/config/env";
import { appendAuditLog } from "@/lib/db/mutations/audit";
import { clearDismissals } from "@/lib/db/mutations/notification-dismissals";
import { notifyBackchannelLogout } from "@/lib/oidc/backchannel-logout";
import { getActiveClient } from "@/lib/db/queries/oidc-clients";
import { clientIp, redirectTo } from "@/lib/http/redirect";
import { detectLanAddresses } from "@/lib/config/lan-address";
import { isRegisteredRedirectUri } from "@/lib/oidc/redirect-uri";
import {
  readSsoSession,
  revokeSsoSession,
  SSO_COOKIE_NAME,
} from "@/lib/session/sso-session";

/**
 * 돌아갈 주소를 정한다.
 *
 * id_token_hint의 서명을 검증하지 않고 aud만 꺼내 쓴다. 언뜻 위험해
 * 보이지만 그렇지 않다 — 이 토큰은 **어느 클라이언트의 허용 목록을 볼지**
 * 고르는 데만 쓰이고, 실제 허가는 DB에 등록된 목록이 준다. 공격자가 aud를
 * 마음대로 바꿔봐야 결국 어떤 클라이언트가 미리 등록해 둔 주소로만 갈 수
 * 있다.
 *
 * 서명을 검증하지 **않는** 적극적 이유도 있다: 로그아웃 시점에는 ID 토큰이
 * 이미 만료돼 있는 게 정상이다(수명 5분). 만료를 이유로 거절하면 정상
 * 로그아웃이 대부분 실패한다.
 */
async function resolvePostLogoutRedirect(
  idTokenHint: string | null,
  requested: string | null
): Promise<string | null> {
  if (!idTokenHint || !requested) return null;

  let audience: string | null = null;
  try {
    const claims = decodeJwt(idTokenHint);
    audience = typeof claims.aud === "string" ? claims.aud : null;
  } catch {
    return null;
  }
  if (!audience) return null;

  const client = await getActiveClient(audience);
  if (!client) return null;

  return isRegisteredRedirectUri(
    requested,
    client.postLogoutRedirectUris,
    allowHttpRedirectUris(),
    detectLanAddresses()
  )
    ? requested
    : null;
}

/**
 * 통합 로그아웃.
 *
 * SSO 세션을 DB에서 폐기한다. 쿠키만 지우는 것으로는 부족하다 — 쿠키
 * 삭제는 브라우저에게 부탁하는 것일 뿐이고, 이미 복사된 토큰은 그대로
 * 살아 있다. 세션을 서버 저장형으로 만든 이유가 바로 이 회수를 위해서다.
 *
 * 각 시스템이 발급한 자기 세션 쿠키까지 끊어주지는 못한다(백채널 로그아웃
 * 미구현). 다만 각 시스템이 매 요청 자기 DB에서 사용자 상태를 다시 읽으므로,
 * 계정 정지는 즉시 반영된다. 남는 구멍은 "정지되진 않았지만 로그아웃한
 * 경우"뿐이다. ID 토큰에 sid를 이미 넣어 두었으므로 나중에 붙일 때
 * 스키마를 바꿀 필요는 없다.
 */
export async function GET(request: NextRequest) {
  const session = await readSsoSession();

  if (session) {
    await revokeSsoSession(session.sessionId);
    await appendAuditLog({
      actorUserId: session.userId,
      actionType: "LOGOUT",
      targetEntity: "sso_sessions",
      targetRecordId: session.sessionId,
      newValue: { via: "rp_initiated" },
      sourceIp: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });

    // 지운 알림 표시를 비운다. 「로그아웃하면 지운 알림이 다시 뜬다」가
    // 브라우저에 적던 시절의 동작이었고, 포털로 모으면서도 그 뜻을 그대로
    // 지킨다(설계안 3-6).
    //
    // 자리를 여기로 잡은 까닭 — **되돌아오지 못할 쪽을 먼저 한다.** 위의 세션
    // 폐기는 대신해 줄 것이 없지만, 지움 정리는 못 해도 하루 뒤 보관 기간이
    // 덮는다(db/retention.ts의 NOTIFICATION_DISMISSAL_RETENTION_DAYS). 그래서
    // 포털 제 DB 일을 여기까지 묶어 두고, 느린 네트워크 호출인 백채널 통보를
    // 마지막에 둔다.
    //
    // 실패해도 로그아웃은 끝까지 간다 — 표 하나의 문제가 전사 로그아웃 장애가
    // 되면 안 된다. 새 규칙이 아니라 이 저장소가 이미 두 번 내린 판단이다:
    // db/mutations/audit.ts(「기록 실패가 본래 작업을 실패시키지 않는다」)와
    // 바로 아래 notifyBackchannelLogout(「시스템 하나가 죽었다고 아무도
    // 로그아웃할 수 없게 되면 안 된다」).
    try {
      await clearDismissals(session.userId);
    } catch (error) {
      console.error(
        "[logout] 알림 지움 기록 정리 실패:",
        session.userId,
        error
      );
    }

    // 각 시스템에도 알린다. 우리 세션만 끊으면 각 시스템이 발급한 자기
    // 쿠키는 그대로 살아 있다. 실패해도 로그아웃 자체는 진행한다 —
    // 시스템 하나가 죽었다고 아무도 로그아웃할 수 없게 되면 안 된다.
    await notifyBackchannelLogout({
      userId: session.userId,
      sessionId: session.sessionId,
      reason: "LOGOUT",
    });
  }

  const query = request.nextUrl.searchParams;
  const target = await resolvePostLogoutRedirect(
    query.get("id_token_hint"),
    query.get("post_logout_redirect_uri")
  );

  // post_logout_redirect_uri를 주지 않은 클라이언트는 로그인 화면에 남는다.
  let destination = "/signin";
  if (target) {
    const url = new URL(target);
    const state = query.get("state");
    if (state) url.searchParams.set("state", state);
    destination = url.href;
  }

  const response = redirectTo(destination, 302);
  response.cookies.set(SSO_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookiesEnabled(),
    path: "/",
    maxAge: 0,
  });
  return response;
}
