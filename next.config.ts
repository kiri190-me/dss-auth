import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
