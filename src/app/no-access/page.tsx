import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getActiveClient } from "@/lib/db/queries/oidc-clients";
import { readSsoSession } from "@/lib/session/sso-session";

export const metadata: Metadata = { title: "접근 권한 없음 | DSS 통합 로그인" };

/**
 * 로그인은 됐지만 그 시스템을 쓸 권한이 없을 때.
 *
 * 클라이언트로 돌려보내지 않고 우리 화면에서 안내하는 이유: 사용자에게는
 * "관리자에게 문의"라는 다음 행동이 있는데, 각 팀이 이 안내를 저마다
 * 다르게 만들게 하면 사용자가 매번 다른 화면을 보게 된다.
 */
export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const session = await readSsoSession();
  if (!session) redirect("/signin");

  const { client: clientId } = await searchParams;
  // 시스템 이름을 보여주되, 없는 client_id를 넣어도 조용히 넘어간다.
  // 여기서 이름이 나오는지 여부로 등록된 시스템 목록을 알아내지 못하도록
  // 실패해도 같은 화면을 보여준다.
  const client = clientId ? await getActiveClient(clientId) : null;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-12 text-center">
      <div className="text-4xl" aria-hidden="true">
        🔒
      </div>
      <h1 className="mt-6 text-xl font-semibold">
        {client ? `${client.name} 사용 권한이 없습니다` : "사용 권한이 없습니다"}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        <strong className="font-medium text-zinc-900 dark:text-zinc-100">
          {session.displayName}
        </strong>
        님은 이 시스템에 접근할 수 있도록 지정되어 있지 않습니다.
        <br />
        필요하시면 관리자에게 요청해 주세요.
      </p>
      <div className="mt-8">
        <Link
          href="/apps"
          className="text-sm text-zinc-500 underline underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          내가 쓸 수 있는 시스템 보기
        </Link>
      </div>
    </main>
  );
}
