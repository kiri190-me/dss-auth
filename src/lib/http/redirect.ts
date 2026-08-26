import { NextResponse } from "next/server";

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

/** 프록시 뒤에서도 클라이언트 IP를 최대한 알아낸다. 없으면 null. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || null;
}
