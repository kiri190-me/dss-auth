import type { MetadataRoute } from "next";

/**
 * 홈 화면에 설치했을 때 주소창 없이 뜨게 하는 설정.
 *
 * Next가 이 파일을 `/manifest.webmanifest`로 서빙하고, layout.tsx의
 * `metadata.manifest`가 <head>에서 그것을 가리킨다. A/S 시스템의 같은
 * 파일과 구조를 맞춰 두었다 — 두 앱이 한 폰에 나란히 설치되므로 동작이
 * 갈리면 사용자가 먼저 알아챈다.
 *
 * ⚠️ `display: "standalone"`은 안드로이드·데스크톱 Chrome만 본다. iOS
 * Safari는 manifest를 보지 않고 layout.tsx의 `appleWebApp.capable`
 * (= apple-mobile-web-app-capable 메타 태그)만 본다. 둘 중 하나만 두면
 * 플랫폼별로 동작이 갈린다.
 *
 * `start_url`이 "/"인 이유: 루트가 세션 상태를 보고 알아서 보낸다 —
 * 로그인해 있으면 /apps, 아니면 /signin. /signin을 직접 넣으면 이미
 * 로그인한 사람이 앱을 열 때마다 리다이렉트가 한 번 더 붙는다.
 *
 * `scope`도 "/"다. 다만 **앱 목록의 타일은 A/S 시스템(다른 출처)으로
 * 나간다** — 그 순간 이 범위를 벗어난다. 안드로이드는 인앱 브라우저로 열고
 * 쿠키를 공유해 대개 동작하지만, iOS는 설치된 웹앱과 Safari의 쿠키 저장소가
 * 분리돼 있어 로그인이 헛돌 수 있다. 근본 해결은 NAS 배포 때 리버스
 * 프록시로 두 시스템을 **같은 출처**에 놓는 것이다(예: `/`는 A/S,
 * `/auth`는 이 포털).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DSS 통합 로그인",
    short_name: "DSS 로그인",
    description: "DSS 사내 시스템 통합 로그인 포털",
    lang: "ko",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      // 회사 로고의 표식(파랑·흰색·빨강 사각형). scripts/generate-icons.ts가
      // 만든다 — 로고가 바뀌면 거기서 색과 비율만 고치고 다시 돌린다.
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      // 안드로이드 런처가 기기별 모양(원형·스쿼클)으로 잘라내는 용도다.
      // 표식이 가운데 안전 영역 안에 들어가도록 별도로 작게 그린 파일이라
      // "any"와 겸용하지 않는다 — 한 파일로 쓰면 어느 한쪽이 반드시 어색해진다.
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
