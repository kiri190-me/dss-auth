import Link from "next/link";
import { requirePortalAdmin } from "@/lib/auth/portal-admin";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // ⚠️ 이 가드는 껍데기(네비게이션)를 그리기 위한 것이지, 차단의 근거가 아니다.
  //
  // Next.js 레이아웃은 클라이언트 전환 시 다시 렌더되지 않고, 하위 세그먼트가
  // 렌더링되는 것을 막지도 못한다(부분 렌더링). 즉 레이아웃에서 막았다고
  // 페이지가 안 도는 게 아니다 — Next 공식 인증 가이드의 "Layouts and auth
  // checks" 항목이 명시하는 내용이다.
  //
  // 그래서 실제 차단은 두 곳에서 따로 한다:
  //   - 각 page.tsx가 requirePortalAdmin()을 스스로 호출한다
  //   - 각 서버 액션이 assertPortalAdmin()을 스스로 호출한다
  // 이 레이아웃이 통째로 없어져도 보안은 그대로여야 한다.
  const admin = await requirePortalAdmin();

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <nav className="flex items-center justify-between gap-4 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="flex items-center gap-4 text-sm">
          <Link href="/apps" className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
            ← 시스템 목록
          </Link>
          <Link href="/admin/users" className="font-medium">
            사용자 관리
          </Link>
        </div>
        <span className="text-xs text-zinc-500">{admin.displayName} · 관리자</span>
      </nav>
      {children}
    </div>
  );
}
