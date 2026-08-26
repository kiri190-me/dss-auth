import { NextResponse } from "next/server";
import { getIssuer } from "@/lib/config/env";
import { buildDiscoveryDocument } from "@/lib/oidc/discovery-document";

// 이 문서는 요청 시점의 환경변수(issuer)에 따라 달라지므로 빌드 때 미리
// 만들어두면 안 된다.
export const dynamic = "force-dynamic";

/**
 * 밖에서 보이는 주소는 /.well-known/openid-configuration 이다
 * (next.config.ts의 rewrites 참고).
 *
 * 다른 팀은 이 주소 하나만 알면 나머지를 전부 알아낸다.
 */
export async function GET() {
  return NextResponse.json(buildDiscoveryDocument(getIssuer()), {
    headers: {
      // 자주 바뀌지 않지만 영원하지도 않다. 5분이면 우리 부하를 줄이면서
      // 설정 변경이 반영되기까지 오래 기다리지 않는다.
      "cache-control": "public, max-age=300",
    },
  });
}
