import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSsoSession } from "@/lib/session/sso-session";
import SignOutButton from "@/components/SignOutButton";

export const metadata: Metadata = { title: "승인 대기 | DSS 통합 로그인" };

export default async function PendingPage() {
  const session = await readSsoSession();
  if (!session) redirect("/signin");
  // 승인이 끝난 사람이 이 화면에 머물러 있을 이유가 없다.
  if (session.status === "ACTIVE") redirect("/apps");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12 text-center">
      <div className="text-4xl" aria-hidden="true">
        ⏳
      </div>
      <h1 className="mt-6 text-xl font-semibold">승인을 기다리는 중입니다</h1>
      <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        <strong className="font-medium text-zinc-900 dark:text-zinc-100">
          {session.displayName}
        </strong>
        님의 계정이 등록되었습니다.
        <br />
        관리자가 확인하면 사내 시스템에 접속할 수 있습니다.
      </p>
      <p className="mt-6 rounded-lg bg-zinc-100 px-4 py-3 text-xs leading-relaxed text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
        승인이 늦어지면 담당자에게 직접 문의해 주세요.
      </p>
      <div className="mt-8">
        <SignOutButton />
      </div>
    </main>
  );
}
