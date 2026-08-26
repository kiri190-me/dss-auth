import "server-only";
import { redirect } from "next/navigation";
import { readSsoSession, type SsoSessionUser } from "@/lib/session/sso-session";

/**
 * 관리자 화면용 가드. 자격이 없으면 각 상황에 맞는 곳으로 보낸다.
 *
 * 화면 가드는 "메뉴를 감추는" 수준이 아니라 실제 차단이다. 다만 이것만
 * 믿으면 안 된다 — 서버 액션은 화면을 거치지 않고 직접 호출될 수 있으므로
 * 각자 assertPortalAdmin()으로 다시 확인한다.
 */
export async function requirePortalAdmin(): Promise<SsoSessionUser> {
  const session = await readSsoSession();
  if (!session) redirect("/signin");
  if (session.status !== "ACTIVE") redirect("/pending");
  if (!session.isPortalAdmin) redirect("/apps");
  return session;
}

export class NotPortalAdminError extends Error {
  constructor() {
    super("포털 관리자 권한이 필요합니다.");
  }
}

/**
 * 서버 액션용 가드.
 *
 * 화면 가드와 별도로 존재하는 이유: 서버 액션은 고유 엔드포인트를 가지므로
 * 화면을 한 번도 열지 않고 직접 호출할 수 있다. 화면에서 막았으니 됐다고
 * 넘기면, 버튼이 안 보이는 것과 실행이 안 되는 것이 달라진다.
 *
 * 리다이렉트 대신 던지는 이유: 액션의 실패는 "다른 화면으로 이동"이 아니라
 * "이 조작이 거부됨"이다.
 */
export async function assertPortalAdmin(): Promise<SsoSessionUser> {
  const session = await readSsoSession();
  if (!session || session.status !== "ACTIVE" || !session.isPortalAdmin) {
    throw new NotPortalAdminError();
  }
  return session;
}
