import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DSS 통합 로그인",
  description: "DSS 사내 시스템 통합 로그인 포털",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // next/font/google을 쓰지 않는다 — 빌드 때 네트워크를 타는 의존성이
    // 생기고(NAS 배포 시 불리), 한글에는 어차피 적용되지 않는다.
    // 시스템 폰트 스택이 한글 렌더링도 가장 깔끔하다.
    <html lang="ko" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
