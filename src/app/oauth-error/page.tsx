import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "연동 오류 | DSS 통합 로그인" };

/**
 * client_id나 redirect_uri를 믿을 수 없을 때의 종착지.
 *
 * 이 화면이 존재하는 이유가 곧 보안 설계다. 이 경우에 요청받은 주소로
 * 리다이렉트하면, 공격자가 임의 주소를 redirect_uri에 넣고 우리를 통해
 * 사용자를 그리로 보낼 수 있게 된다(열린 리다이렉터). 그래서 밖으로
 * 내보내지 않고 우리 화면에서 끝낸다.
 */
const REASONS: Record<string, { title: string; detail: string }> = {
  unknown_client: {
    title: "등록되지 않은 시스템입니다",
    detail:
      "이 시스템은 DSS 통합 로그인에 등록되어 있지 않거나 사용 중지되었습니다.",
  },
  bad_redirect_uri: {
    title: "돌아갈 주소가 등록되어 있지 않습니다",
    detail:
      "요청에 실린 주소가 등록된 값과 정확히 일치하지 않습니다. 주소가 한 글자라도 다르면 거절됩니다.",
  },
};

const FALLBACK = {
  title: "요청을 처리할 수 없습니다",
  detail: "연동 설정을 확인해야 합니다.",
};

export default async function OAuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const reason = (code && REASONS[code]) || FALLBACK;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-12 text-center">
      <div className="text-4xl" aria-hidden="true">
        ⚠️
      </div>
      <h1 className="mt-6 text-xl font-semibold">{reason.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        {reason.detail}
      </p>
      <p className="mt-6 rounded-lg bg-zinc-100 px-4 py-3 text-xs leading-relaxed text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
        이 화면은 사용자가 해결할 수 있는 문제가 아닙니다.
        <br />
        해당 시스템 담당자에게 알려주세요.
      </p>
      <div className="mt-8">
        <Link
          href="/apps"
          className="text-sm text-zinc-500 underline underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          시스템 목록으로
        </Link>
      </div>
    </main>
  );
}
