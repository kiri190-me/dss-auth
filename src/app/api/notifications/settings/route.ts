import { NextResponse } from "next/server";
import {
  getNotificationSettings,
  saveNotificationSettings,
} from "@/lib/notifications/service";
import { parseSettingsChanges } from "@/lib/notifications/settings";
import { readSsoSession } from "@/lib/session/sso-session";

/**
 * ============================================================================
 * 알림 설정 창구 — 읽고(GET), 그 시스템으로 되돌려 보낸다(PUT)
 * ============================================================================
 * 설계 결정(2026-09-21, 설계서 D-5): 화면만 포털로 옮기고 **값의 주인은 각
 * 시스템**이다. 이 라우트는 그 값을 갖지 않는다 — 물어서 그대로 내주고, 받아서
 * 그대로 넘긴다.
 *
 * 🔴 **403 은 정상 응답의 하나다.** A/S 는 설정 읽기·쓰기 둘 다 관리자 이상만
 * 허용한다. 관리자가 아닌 사람에게 GET 은 200 과 함께 시스템마다
 * `status: "forbidden"` 을 담아 돌려준다 — 화면이 「그 시스템은 볼 수 없습니다」
 * 라고 적을 수 있어야 하기 때문이고, 통로 전체가 403 이 되면 시스템이 둘 이상일
 * 때 나머지까지 못 보게 된다.
 *
 * ── PUT 인 것과 CSRF ───────────────────────────────────────────────────────
 * 보낸 종류들의 값을 그 상태로 맞추는 조작이라(같은 요청을 두 번 보내도 결과가
 * 같다) POST 보다 PUT 이 맞다. 그리고 별도 CSRF 토큰을 두지 않은 근거는
 * api/session/logout 과 같다 — 세션 쿠키가 SameSite=Lax 라 다른 사이트가 보낸
 * 요청에는 쿠키 자체가 실리지 않고, 쿠키가 없으면 readSsoSession 이 null 이라
 * 아무것도 바뀌지 않는다. 여기엔 한 겹 더 있다: HTML 폼은 PUT 을 보낼 수 없고
 * JSON 본문은 사전 요청(preflight)을 부른다.
 * ============================================================================
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
}

function notActive() {
  return NextResponse.json({ error: "not_active" }, { status: 403, headers: NO_STORE });
}

export async function GET() {
  const session = await readSsoSession();
  if (!session) return unauthorized();
  if (session.status !== "ACTIVE") return notActive();

  return NextResponse.json(await getNotificationSettings(session.userId), {
    headers: NO_STORE,
  });
}

export async function PUT(request: Request) {
  const session = await readSsoSession();
  if (!session) return unauthorized();
  if (session.status !== "ACTIVE") return notActive();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_request", message: "요청 본문을 읽을 수 없습니다." },
      { status: 400, headers: NO_STORE }
    );
  }

  // 어느 시스템의 설정인가. 🔴 이 값이 곧 토큰의 aud 가 되므로, 들어갈 수 있는
  // 시스템인지는 service.ts 가 다시 본다.
  const clientId = (body as { clientId?: unknown }).clientId;
  if (typeof clientId !== "string" || clientId === "") {
    return NextResponse.json(
      { error: "invalid_request", message: "어느 시스템의 설정인지 알 수 없습니다." },
      { status: 400, headers: NO_STORE }
    );
  }

  const parsed = parseSettingsChanges(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid_request", message: parsed.message },
      { status: 400, headers: NO_STORE }
    );
  }

  const result = await saveNotificationSettings({
    userId: session.userId,
    clientId,
    changes: parsed.changes,
  });

  if (result.status === "ok") {
    return NextResponse.json(
      { ok: true, changedCount: result.changedCount },
      { headers: NO_STORE }
    );
  }

  // 그 시스템이 거절한 것과 못 닿은 것을 다른 코드로 내준다 — 화면이 「권한이
  // 없습니다」와 「지금은 저장할 수 없습니다」를 다르게 적어야 한다.
  const status =
    result.status === "forbidden" ? 403 : result.status === "invalid" ? 400 : 502;
  return NextResponse.json(
    { error: result.status, message: result.message },
    { status, headers: NO_STORE }
  );
}
