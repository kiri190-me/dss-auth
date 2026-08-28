import type { Metadata } from "next";
import { redirect } from "next/navigation";
import DssLogo from "@/components/DssLogo";
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
  // 이 둘은 비밀번호가 맞았다는 사실을 드러낸다. 여기 닿으려면 이미
  // 비밀번호를 알아야 하므로, 모르는 사람에게 새는 정보가 아니다.
  totp_required: "인증 앱의 6자리 코드를 함께 넣어 주세요.",
  totp_invalid: "인증 코드가 올바르지 않습니다. 앱에 뜬 코드를 다시 확인해 주세요.",
};

export default async function EmergencySignInPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    minutes?: string;
    seconds?: string;
    returnTo?: string;
  }>;
}) {
  const { error, minutes, seconds, returnTo } = await searchParams;

  const safeReturnTo = sanitizeReturnTo(returnTo ?? null);

  const session = await readSsoSession();
  if (session) {
    redirect(session.status === "ACTIVE" ? (safeReturnTo ?? "/apps") : "/pending");
  }

  // 잠금(locked)과 혼잡(too_many)은 다른 사건이다. 앞은 이 계정이 5번
  // 틀린 것이고, 뒤는 서버가 지금 비상 로그인 시도를 너무 많이 받고 있다는
  // 뜻이다 — 내 계정은 아직 멀쩡하고 기다리는 시간도 훨씬 짧다. 두 문구를
  // 같게 만들면 관리자가 "내가 잠갔구나" 하고 15분을 헛되이 기다린다.
  const message =
    error === "locked"
      ? `너무 여러 번 실패했습니다. ${minutes ?? "15"}분 뒤에 다시 시도해 주세요.`
      : error === "too_many"
        ? `로그인 시도가 몰리고 있습니다. ${seconds ?? "60"}초 뒤에 다시 시도해 주세요.`
        : error
          ? (ERROR_MESSAGES[error] ?? ERROR_MESSAGES.invalid)
          : null;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-12">
      <div className="flex flex-col items-center text-center">
        <DssLogo />
        <h1 className="mt-4 text-2xl font-bold tracking-tight">DSS</h1>
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

        {/*
          2단계 인증을 켠 계정에서만 쓰이지만 칸은 언제나 보인다.

          아이디를 치기 전에는 그 계정이 2단계 인증을 쓰는지 알 수 없고,
          알아내려고 서버에 물으면 그 응답 자체가 "이 아이디는 존재한다"를
          알려주는 조회 도구가 된다. 켜지 않은 계정에서는 여기 무엇을 넣든
          무시된다.
        */}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            인증 코드{" "}
            <span className="font-normal text-zinc-500">
              (2단계 인증을 켠 경우)
            </span>
          </span>
          <input
            name="totpCode"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 -]*"
            maxLength={9}
            placeholder="000000"
            className="h-11 rounded-lg border border-zinc-300 bg-white px-3 font-mono text-[15px] tracking-[0.2em] text-zinc-900 outline-none focus-visible:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus-visible:border-zinc-100"
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
