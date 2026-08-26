/**
 * 로그아웃은 서버 상태를 바꾸므로 반드시 POST 폼이다.
 * GET 링크로 두면 이미지 태그 하나로 남을 로그아웃시킬 수 있다.
 */
export default function SignOutButton() {
  return (
    <form action="/api/session/logout" method="post">
      <button
        type="submit"
        className="text-sm text-zinc-500 underline underline-offset-4 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        로그아웃
      </button>
    </form>
  );
}
