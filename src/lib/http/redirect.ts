import { NextResponse } from "next/server";
import { trustedProxyHops } from "@/lib/config/env";
import { trustedClientIp } from "./client-key";

/**
 * 상대 경로 Location으로 리다이렉트한다.
 *
 * `NextResponse.redirect(new URL(path, request.url))`을 쓰지 않는 이유:
 * A/S 시스템에서 실측된 바로, `next dev`가 LAN 클라이언트의 요청에도
 * `request.url`을 서버 자신의 바인드 주소(`http://localhost:3100`)로
 * 보고하는 경우가 있다. 그러면 폰이 따라갈 수 없는 Location이 나간다
 * (폰에게 localhost는 폰 자신이다).
 *
 * RFC 9110에 따라 브라우저는 상대 Location을 요청의 실제 출처 기준으로
 * 해석하므로, 이 방식은 localhost·LAN IP·실제 도메인 어디서나 똑같이 동작한다.
 */
export function redirectTo(path: string, status: 302 | 303 = 303): NextResponse {
  return new NextResponse(null, { status, headers: { Location: path } });
}

/**
 * 감사 로그에 남길 클라이언트 IP. 믿을 수 없으면 null.
 *
 * 예전에는 x-forwarded-for의 **첫** 값을 검사 없이 썼다. 그 값은 클라이언트가
 * 직접 써 보낼 수 있어(Next는 XFF가 있으면 덮어쓰지 않는다) 감사 로그에
 * 아무 주소나 남길 수 있었다. 이제 신뢰하는 프록시가 덧붙인 자리만 읽는다 —
 * 판정과 그 근거는 client-key.ts에 있다.
 *
 * 믿을 수 없을 때 그럴듯한 값을 남기지 않고 null을 남기는 이유: 감사 로그에
 * 적힌 주소는 나중에 사람이 근거로 삼는 값이다. 위조된 주소가 적혀 있는 것이
 * 비어 있는 것보다 나쁘다.
 */
export function clientIp(request: Request): string | null {
  return trustedClientIp(
    request.headers.get("x-forwarded-for"),
    trustedProxyHops()
  );
}
