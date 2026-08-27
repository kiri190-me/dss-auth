import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { emergencySignIn } from "@/lib/server/actions/emergency-signin";
import { sanitizeReturnTo } from "@/lib/session/login-tx";
import { readSsoSession } from "@/lib/session/sso-session";

export const metadata: Metadata = {
  title: "비상 로그인 | DSS 통합 로그인",
  // 검색 로봇이 색인하지 않게 한다. 사내망 전용이라 실효는 작지만,
  // 나중에 도메인을 붙였을 때 이 화면이 검색 결과에 뜨면 안 된다.
  robots: { index: false, follow: false },
};

/**
 * 카카오를 거치지 않는 유일한 로그인 화면.
 *
 * 실패 사유를 어디까지 알려줄지 — /signin과 같은 원칙(내부 사정을 노출하지
 * 않는다)을 따르되, 잠금만은 예외로 알려준다. 이 화면이 쓰이는 순간은
 * "카카오가 죽어 아무도 못 들어가는" 때이고, 그때 왜 안 되는지 모른 채
 * 15분을 헤매면 잠금 장치가 사고를 키운다. 잠겼다는 사실이 아이디의 존재를
 * 알려주긴 하지만, 그걸 알아내려면 이미 5번을 맞게 찍어야 한다.
 */
const ERROR_MESSAGES: Record<string, string> = {
  invalid: "아이디 또는 비밀번호가 올바르지 않습니다.",
  not_active: "사용할 수 없는 계정입니다.",
};

export default async function EmergencySignInPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    minutes?: string;
    returnTo?: string;
  }>;
}) {
  const { error, minutes, returnTo } = await searchParams;

  const safeReturnTo = sanitizeReturnTo(returnTo ?? null);

  const session = await readSsoSession();
  if (session) {
    redirect(session.status === "ACTIVE" ? (safeReturnTo ?? "/apps") : "/pending");
  }

  const message =
    error === "locked"
      ? `너무 여러 번 실패했습니다. ${minutes ?? "15"}분 뒤에 다시 시도해 주세요.`
      : error
        ? (ERROR_MESSAGES[error] ?? ERROR_MESSAGES.invalid)
        : null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">DSS</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">비상 로그인</p>
      </div>

      <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
        카카오 로그인을 쓸 수 없을 때만 사용하는 통로입니다. 사용 기록은 모두
        감사 로그에 남습니다.
      </p>

      {message ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {message}
        </p>
      ) : null}

      <form action={emergencySignIn} className="mt-6 flex flex-col gap-3">
        {safeReturnTo ? (
          <input type="hidden" name="returnTo" value={safeReturnTo} />
        ) : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            아이디
          </span>
          <input
            name="loginId"
            type="text"
            required
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-[15px] text-zinc-900 outline-none focus-visible:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus-visible:border-zinc-100"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            비밀번호
          </span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-[15px] text-zinc-900 outline-none focus-visible:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus-visible:border-zinc-100"
          />
        </label>

        <button
          type="submit"
          className="mt-2 flex h-12 items-center justify-center rounded-lg bg-zinc-900 px-4 text-[15px] font-semibold text-zinc-50 transition-opacity hover:opacity-90 dark:bg-zinc-50 dark:text-zinc-900"
        >
          로그인
        </button>
      </form>

      <a
        href="/signin"
        className="mt-6 text-center text-xs text-zinc-500 underline underline-offset-2 dark:text-zinc-500"
      >
        카카오 로그인으로 돌아가기
      </a>
    </main>
  );
}
