import { redirect } from "next/navigation";
import { readSsoSession } from "@/lib/session/sso-session";

/**
 * 루트는 자체 화면을 갖지 않고 상태에 맞는 곳으로 보낸다.
 * 로그인 여부를 판단하는 곳이 한 군데뿐이어야 어긋나지 않는다.
 */
export default async function RootPage() {
  const session = await readSsoSession();
  if (!session) redirect("/signin");
  redirect(session.status === "ACTIVE" ? "/apps" : "/pending");
}
