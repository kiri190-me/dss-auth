import type { NextConfig } from "next";

/**
 * 모든 응답에 붙는 보안 헤더.
 *
 * 리버스 프록시에서 붙일 수도 있지만 여기 두는 쪽을 골랐다. 프록시 설정은
 * 저장소 밖에 있어 배포할 때마다 다시 맞춰야 하고, 개발 서버에는 아예 없어서
 * "우리 화면이 iframe에 실리는가" 같은 것을 개발 중에 확인할 수 없다.
 * 프록시에서 한 번 더 붙어도 해롭지 않다.
 *
 * CSP는 frame-ancestors 하나만 둔다. 전체 CSP는 Next의 인라인 스크립트·
 * 스타일과 부딪혀 화면이 조용히 깨지기 쉬운데, 그 확인 없이 넣는 것은
 * 안전장치가 아니라 시한폭탄이다. frame-ancestors는 그 위험이 없고
 * X-Frame-Options의 현대적 대체이기도 하다.
 */
const SECURITY_HEADERS = [
  // 로그인 화면이 남의 페이지 안에 실려 클릭을 가로채이는 것을 막는다
  // (클릭재킹). 로그인 화면은 특히 표적이 된다 — 사람이 거기서 진짜
  // 자격증명을 다루기 때문이다.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  // 브라우저가 Content-Type을 무시하고 내용을 추측하지 못하게 한다.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // 다른 사이트로 나갈 때 우리 주소를 넘기지 않는다. 인가 요청 주소에는
  // state·nonce·redirect_uri가 붙어 있어 Referer로 새면 안 된다.
  { key: "Referrer-Policy", value: "same-origin" },
  // 쓰지 않는 브라우저 기능을 닫는다. 로그인 서버가 카메라나 위치를 물을
  // 이유가 없고, 닫아 두면 화면이 바뀌었을 때 눈에 띈다.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // HSTS는 http 응답에서는 브라우저가 무시하므로 붙여 두어도 해롭지 않고,
  // HTTPS로 옮기는 날 따로 기억해 낼 필요가 없어진다. 2년.
  //
  // preload는 넣지 않는다 — 사내망 도메인을 브라우저 내장 목록에 올리면
  // 되돌리는 데 몇 달이 걸린다.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },

  // NAS Docker 이미지를 위한 설정. 실행에 필요한 파일만 추려 이미지가
  // 훨씬 작아진다. 지금 넣어두면 배포 단계에서 다시 손대지 않아도 된다.
  output: "standalone",

  async rewrites() {
    return [
      // 표준이 정한 주소는 /.well-known/... 인데, App Router에서 점(.)으로
      // 시작하는 폴더는 라우트로 잡히지 않는다. 실제 구현은 평범한 경로에
      // 두고 여기서 이어 붙인다 — 밖에서 보이는 주소는 규격 그대로다.
      {
        source: "/.well-known/openid-configuration",
        destination: "/api/oidc/discovery",
      },
      {
        source: "/.well-known/jwks.json",
        destination: "/api/oidc/jwks",
      },
    ];
  },
};

export default nextConfig;
