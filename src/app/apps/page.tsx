import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import SignOutButton from "@/components/SignOutButton";
import { listAccessibleClients } from "@/lib/db/queries/clients";
import { readSsoSession } from "@/lib/session/sso-session";

export const metadata: Metadata = { title: "시스템 목록 | DSS 통합 로그인" };

export default async function AppsPage() {
  const session = await readSsoSession();
  if (!session) redirect("/signin");
  if (session.status !== "ACTIVE") redirect("/pending");

  const tiles = await listAccessibleClients(session.userId);

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">사내 시스템</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {session.displayName}님
            {session.isPortalAdmin ? " · 포털 관리자" : ""}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {session.isPortalAdmin ? (
            <Link
              href="/admin/users"
              className="text-sm text-zinc-500 underline underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              사용자 관리
            </Link>
          ) : null}
          <SignOutButton />
        </div>
      </header>

      {tiles.length === 0 ? (
        <p className="mt-10 rounded-lg border border-dashed border-zinc-300 px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          아직 연결된 시스템이 없습니다.
        </p>
      ) : (
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {tiles.map((tile) => (
            <li key={tile.clientId}>
              <a
                href={tile.launcherUrl ?? "#"}
                className="flex h-full flex-col rounded-xl border border-zinc-200 p-5 transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <span className="text-2xl" aria-hidden="true">
                  {tile.launcherIcon ?? "🔗"}
                </span>
                <span className="mt-3 font-medium">{tile.name}</span>
                {tile.description ? (
                  <span className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                    {tile.description}
                  </span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
