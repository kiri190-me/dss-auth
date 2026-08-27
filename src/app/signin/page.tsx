import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { sanitizeReturnTo } from "@/lib/session/login-tx";
import { readSsoSession } from "@/lib/session/sso-session";

export const metadata: Metadata = { title: "로그인 | DSS 통합 로그인" };

/**
 * 실패 사유별 안내 문구.
 *
 * 내부 사정을 그대로 노출하지 않는다. 예를 들어 "정지된 계정"과 "없는 계정"을
 * 구분해 보여주면, 로그인 화면이 "이 사람이 우리 회사 직원인가"를 알려주는
 * 조회 도구가 되어버린다.
 */
const ERROR_MESSAGES: Record<string, string> = {
  cancelled: "카카오 로그인을 취소했습니다.",
  expired: "로그인 시간이 초과되었습니다. 다시 시도해 주세요.",
  state: "로그인 요청을 확인할 수 없습니다. 다시 시도해 주세요.",
  kakao: "카카오 로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  suspended: "사용할 수 없는 계정입니다. 관리자에게 문의하세요.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string; force?: string }>;
}) {
  const { error, returnTo, force } = await searchParams;

  // force=1은 인가 요청에 prompt=login이 실려 왔다는 뜻이다. 이미 로그인해
  // 있어도 그냥 통과시키지 않고 카카오 왕복을 한 번 더 돌게 한다.
  //
  // 한계를 정직하게 적어둔다: 카카오가 다시 비밀번호를 묻느냐는 카카오가
  // 정한다. 우리가 보장하는 것은 "새 인가 왕복을 거쳤고 auth_time이
  // 갱신된다"까지다. 완전한 재인증이 필요한 조작이 생기면 그때는 이 값에
  // 기대지 말고 별도 확인 수단을 둬야 한다.
  const forceReauth = force === "1";

  // ⚠️ returnTo는 주소창에서 온 값이다. 그대로 redirect에 넘기면
  // ?returnTo=https://악성사이트 로 사용자를 보낼 수 있는 오픈 리다이렉터가
  // 된다. 경로 형태만 통과시킨다.
  const safeReturnTo = sanitizeReturnTo(returnTo ?? null);

  const session = await readSsoSession();
  if (session && !forceReauth) {
    redirect(
      session.status === "ACTIVE" ? (safeReturnTo ?? "/apps") : "/pending"
    );
  }

  const message = error ? (ERROR_MESSAGES[error] ?? ERROR_MESSAGES.kakao) : null;

  const startUrl = safeReturnTo
    ? `/api/kakao/start?returnTo=${encodeURIComponent(safeReturnTo)}`
    : "/api/kakao/start";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">DSS</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          사내 시스템 통합 로그인
        </p>
      </div>

      {message ? (
        <p
          role="alert"
          className="mt-8 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {message}
        </p>
      ) : null}

      {/*
        일반 링크(GET)다. 로그인 시작은 상태를 바꾸지 않으므로 폼이 필요 없고,
        폼이 없으면 CSRF 토큰도 필요 없다. 실제 방어는 state 파라미터가 한다.
      */}
      <a
        href={startUrl}
        className="mt-8 flex h-12 items-center justify-center gap-2 rounded-lg bg-[#FEE500] px-4 text-[15px] font-semibold text-[#191919] transition-opacity hover:opacity-90"
      >
        <span aria-hidden="true">💬</span>
        카카오로 로그인
      </a>

      <p className="mt-6 text-center text-xs leading-relaxed text-zinc-500 dark:text-zinc-500">
        처음 로그인하시면 관리자 승인 후 이용할 수 있습니다.
        <br />
        카카오에서 받아오는 정보는 회원번호와 닉네임뿐입니다.
      </p>

      {/*
        비상 로그인 통로. 눈에 띄지 않게 두되 숨기지는 않는다 — 이 링크가
        필요해지는 순간은 카카오가 죽어 위 버튼이 아무 일도 하지 않을 때이고,
        그때 주소를 외우고 있어야만 들어갈 수 있으면 통로가 없는 것과 같다.
      */}
      <a
        href={
          safeReturnTo
            ? `/signin/emergency?returnTo=${encodeURIComponent(safeReturnTo)}`
            : "/signin/emergency"
        }
        className="mt-8 text-center text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
      >
        카카오를 쓸 수 없나요?
      </a>
    </main>
  );
}
