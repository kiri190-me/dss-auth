/**
 * 로그아웃은 서버 상태를 바꾸므로 반드시 POST 폼이다.
 * GET 링크로 두면 이미지 태그 하나로 남을 로그아웃시킬 수 있다.
 */
const DEFAULT_CLASS =
  "text-sm text-zinc-500 underline underline-offset-4 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100";

export default function SignOutButton({ className }: { className?: string }) {
  return (
    // 🔴 `<form>` 자체에도 높이가 생긴다. flex 줄 안에 놓일 때 단추만 키를
    //    맞추면 그 단추를 감싼 이 폼이 기본 블록 높이로 서서 다시 어긋난다 —
    //    `inline-flex` 로 두어 폼이 속의 단추만큼만 차지하게 한다.
    <form action="/api/session/logout" method="post" className="inline-flex">
      {/*
        🔵 className 을 안 받으면 지금까지의 밑줄 모양 그대로다. 이 조각을 쓰는
        화면이 둘인데(`/apps` · `/pending`) 종이 있는 쪽만 단추 모양으로
        바뀌었다(2026-11-18) — 기본값을 바꾸면 종이 없는 화면까지 따라 바뀐다.
      */}
      <button type="submit" className={className ?? DEFAULT_CLASS}>
        로그아웃
      </button>
    </form>
  );
}
