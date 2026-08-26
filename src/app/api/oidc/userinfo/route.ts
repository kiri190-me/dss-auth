import { NextResponse } from "next/server";
import { getUserById } from "@/lib/db/queries/users";
import { resolveAccessToken } from "@/lib/oidc/access-token";

const NO_STORE = { "cache-control": "no-store" };

function unauthorized(description: string) {
  return NextResponse.json(
    { error: "invalid_token", error_description: description },
    {
      status: 401,
      headers: {
        ...NO_STORE,
        "www-authenticate": `Bearer error="invalid_token"`,
      },
    }
  );
}

/**
 * 사용자 정보 조회.
 *
 * 직접 쓸 일은 거의 없다 — ID 토큰에 이미 같은 정보가 들어 있다. 그래도
 * 구현해 두는 이유는 next-auth 같은 라이브러리가 기본 설정에서 이 주소를
 * 호출하기 때문이다. 없으면 붙이는 쪽이 설정을 손봐야 한다.
 *
 * sub는 반드시 ID 토큰의 sub와 같아야 한다(OIDC Core §5.3.2). 다르면
 * 받는 쪽이 토큰 바꿔치기로 판단해 거절한다.
 */
export async function GET(request: Request) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return unauthorized("Bearer 토큰이 필요합니다.");
  }

  const granted = await resolveAccessToken(header.slice(7).trim());
  if (!granted) {
    return unauthorized("토큰이 유효하지 않습니다.");
  }

  // 토큰이 유효해도 그 사이에 계정이 정지됐을 수 있다. 매번 다시 읽는다.
  const user = await getUserById(granted.userId);
  if (!user || user.status !== "ACTIVE") {
    return unauthorized("사용할 수 없는 계정입니다.");
  }

  const scopes = granted.scope.split(/\s+/).filter(Boolean);
  const claims: Record<string, unknown> = {
    sub: user.id,
  };
  if (scopes.includes("profile")) {
    claims.name = user.displayName;
    claims.preferred_username = user.displayName;
  }
  // 이메일은 email scope를 요청했고 실제 값이 있을 때만 담는다.
  if (scopes.includes("email") && user.email) {
    claims.email = user.email;
    // 우리는 이메일 소유를 확인하지 않는다(관리자가 손으로 입력한 값이다).
    claims.email_verified = false;
  }

  return NextResponse.json(claims, { headers: NO_STORE });
}
