import { NextResponse } from "next/server";
import { getPublicJwks } from "@/lib/crypto/keys";

export const dynamic = "force-dynamic";

/**
 * 검증용 공개키 목록. 밖에서 보이는 주소는 /.well-known/jwks.json 이다.
 *
 * 여기에 실리는 것은 공개키뿐이며, 유출돼도 무해하다 — 서명을 만들 수는
 * 없고 확인만 할 수 있다. 그래도 개인키 필드가 섞이지 않도록 toPublicJwk가
 * 공개 필드만 남긴다(public-jwk.test.ts로 묶여 있다).
 *
 * 키 교체 중에는 공개키가 둘 이상 실린다. 아직 유효한 옛 토큰도 검증되어야
 * 하기 때문이다.
 */
export async function GET() {
  return NextResponse.json(await getPublicJwks(), {
    headers: {
      // 1시간. 받는 쪽이 매 요청 우리에게 물어보면 우리가 단일 병목이 된다.
      // 키 교체 절차가 "새 공개키를 먼저 노출하고 24시간 기다린다"인 것은
      // 이 캐시가 자연 만료되기를 기다리는 것이다.
      "cache-control": "public, max-age=3600",
    },
  });
}
