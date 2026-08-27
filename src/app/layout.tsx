import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DSS 통합 로그인",
  description: "DSS 사내 시스템 통합 로그인 포털",
  // 홈 화면 설치용(app/manifest.ts가 만드는 경로). 안드로이드·데스크톱
  // Chrome이 이 manifest의 display 값을 보고 주소창 없는 창으로 띄운다.
  manifest: "/manifest.webmanifest",
  // iOS Safari는 manifest를 보지 않는다 — 이 메타 태그만 본다. 이것이 없으면
  // "홈 화면에 추가"를 해도 그냥 북마크가 되어 Safari로 열린다. 두 경로를
  // 같이 유지해야 플랫폼별로 동작이 갈리지 않는다.
  //
  // statusBarStyle은 기본값 "default"를 명시해 둔 것이다 —
  // black-translucent와 달리 상태 표시줄이 콘텐츠 위를 덮지 않아 상단 보정이
  // 따로 필요 없다.
  appleWebApp: {
    capable: true,
    title: "DSS 로그인",
    statusBarStyle: "default",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
  other: {
    // Next 16은 `capable: true`를 표준 이름 `mobile-web-app-capable`로만 낸다
    // (dist/docs 04-functions/generate-metadata.md에서 확인).
    //
    // 그런데 iOS Safari가 그 이름을 인정하기 시작한 것은 17.4부터다. 그 이전
    // 기기에서는 구형 이름만 본다 — 없으면 "홈 화면에 추가"를 해도 그냥
    // 북마크가 되어 Safari로 열린다. 정확히 이번에 겪은 증상이다.
    //
    // 둘을 함께 두는 데 드는 비용은 없고, 구형 기기를 덮는다.
    "apple-mobile-web-app-capable": "yes",
  },
};

/**
 * `viewportFit: "cover"`가 아래 안전 영역 보정의 전제 조건이다.
 *
 * 이 값이 없으면(기본값 `auto`) 뷰포트가 애초에 안전 영역 안쪽으로만 잡히고,
 * 그 결과 CSS의 `env(safe-area-inset-*)`가 어디서든 0으로 계산된다 —
 * 넣어 둔 인셋 패딩이 조용히 무효가 된다는 뜻이다. `cover`로 화면 전체를
 * 쓰게 한 다음, 노치·홈 인디케이터에 겹치면 안 되는 곳에만 인셋을 되돌린다.
 * (A/S 시스템이 같은 이유로 같은 값을 쓴다.)
 *
 * themeColor는 홈 화면에 설치했을 때 상태 표시줄 색이다. 본문 배경과 같은
 * 값을 써서 화면과 이어져 보이게 한다.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
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
    <html lang="ko" className="antialiased">
      <body className="flex flex-col">{children}</body>
    </html>
  );
}
