import "server-only";
import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  getKakaoClientId,
  getKakaoClientSecret,
  getKakaoRedirectUri,
} from "@/lib/config/env";

/**
 * 카카오 OIDC 엔드포인트.
 *
 * 아래 값은 https://kauth.kakao.com/.well-known/openid-configuration 을 직접
 * 조회해 확인한 것이다. 매 로그인마다 discovery를 다시 받지 않고 상수로 둔
 * 이유: 네트워크 왕복이 하나 늘고, 카카오 discovery가 잠깐 안 되면 로그인이
 * 통째로 막히는 실패 지점이 하나 더 생긴다. 공개키(JWKS)만은 상수로 둘 수
 * 없어서(카카오가 키를 교체한다) jose의 createRemoteJWKSet에 맡긴다.
 *
 * 확인된 제약:
 *  - response_types_supported: ["code"]           → Authorization Code Flow만
 *  - id_token_signing_alg: ["RS256"]
 *  - code_challenge_methods_supported: ["S256"]   → PKCE 사용
 *  - subject_types_supported: pairwise            → sub가 앱마다 다르다
 */
export const KAKAO_ISSUER = "https://kauth.kakao.com";
const KAKAO_AUTHORIZATION_ENDPOINT = `${KAKAO_ISSUER}/oauth/authorize`;
const KAKAO_TOKEN_ENDPOINT = `${KAKAO_ISSUER}/oauth/token`;
const KAKAO_JWKS_URI = `${KAKAO_ISSUER}/.well-known/jwks.json`;

/**
 * 모듈 최상위에서 한 번만 만든다. jose가 내부적으로 캐시와 재조회 쿨다운을
 * 관리하므로, 요청마다 새로 만들면 카카오에 불필요한 부하를 준다.
 */
const kakaoJwks = createRemoteJWKSet(new URL(KAKAO_JWKS_URI));

/**
 * scope에 openid가 반드시 있어야 id_token이 나온다. 이게 빠지면 카카오는
 * 평범한 OAuth 응답만 주고, 그러면 우리 설계가 성립하지 않는다.
 *
 * profile_nickname만 받는다. 이메일·전화번호 같은 개인정보는 비즈니스 앱
 * 전환과 심사가 필요할 수 있고, 어차피 실명·소속은 관리자가 승인하면서
 * 직접 입력하므로 카카오에서 받아올 이유가 없다.
 */
const KAKAO_SCOPE = "openid profile_nickname";

/**
 * `prompt`를 붙이지 않는다 — 카카오가 기억하고 있으면 그대로 통과시킨다.
 *
 * 한 번 `prompt=login`을 붙여 봤다가 되돌렸다. 로그아웃 뒤에 카카오가 아이디와
 * 비밀번호를 다시 묻는 것이 통합 로그인의 목적과 정면으로 어긋난다 — 로그인을
 * 한 번만 하려고 만든 물건이다.
 *
 * 대신 로그아웃이 지우는 것은 **우리 세션**이다(sso_sessions에서 폐기). 카카오가
 * 이 브라우저를 기억하는 것과, 이 사람이 사내 시스템에 들어와 있는 것은 다른
 * 문제다. 공용 PC에서 카카오 계정까지 끊으려면 카카오에서 로그아웃해야 하고,
 * 그건 우리가 대신해 줄 수 있는 일이 아니다.
 */
export function buildKakaoAuthorizeUrl(params: {
  state: string;
  nonce: string;
  codeVerifier: string;
}): string {
  const codeChallenge = createHash("sha256")
    .update(params.codeVerifier, "ascii")
    .digest("base64url");

  const url = new URL(KAKAO_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: getKakaoClientId(),
    redirect_uri: getKakaoRedirectUri(),
    response_type: "code",
    scope: KAKAO_SCOPE,
    state: params.state,
    nonce: params.nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}

export type KakaoProfile = {
  /** 카카오 회원번호. 이 앱에 한정된 값이다(pairwise). 신원의 유일한 기준. */
  subject: string;
  /** 사용자가 동의하지 않으면 없을 수 있다. */
  nickname: string | null;
};

export class KakaoExchangeError extends Error {}

/**
 * 인가 코드를 토큰으로 바꾸고 id_token을 검증해 프로필을 돌려준다.
 *
 * 검증에 실패하면 반드시 던진다 — "일단 로그인시키고 나중에 확인" 같은
 * 여지를 두지 않는다.
 */
export async function exchangeKakaoCode(params: {
  code: string;
  codeVerifier: string;
  expectedNonce: string;
}): Promise<KakaoProfile> {
  let response: Response;
  try {
    response = await fetch(KAKAO_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: getKakaoClientId(),
        // 카카오는 client_secret_basic을 지원하지 않는다. 본문에 실어야 한다.
        client_secret: getKakaoClientSecret(),
        // 인가 요청 때와 문자 단위로 같아야 한다.
        redirect_uri: getKakaoRedirectUri(),
        code: params.code,
        code_verifier: params.codeVerifier,
      }),
      cache: "no-store",
    });
  } catch (cause) {
    // NAS에서 인터넷이 막혀 있으면 여기로 온다.
    throw new KakaoExchangeError("카카오 서버에 연결할 수 없습니다.", { cause });
  }

  if (!response.ok) {
    // 본문에 client_secret이 들어갈 일은 없지만, 카카오 오류 응답을 그대로
    // 사용자에게 보여주지는 않는다(내부 설정이 드러날 수 있다).
    throw new KakaoExchangeError(
      `카카오 토큰 교환이 거절되었습니다 (HTTP ${response.status}).`
    );
  }

  const body = (await response.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") {
    throw new KakaoExchangeError(
      "카카오 응답에 id_token이 없습니다. 개발자 콘솔에서 OpenID Connect가 켜져 있는지 확인하세요."
    );
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(body.id_token, kakaoJwks, {
      issuer: KAKAO_ISSUER,
      audience: getKakaoClientId(),
      // NAS 시계가 몇 초 어긋나도 통과시킨다. 30초를 넘게 벌어지면
      // 그건 흡수할 게 아니라 시계를 고쳐야 하는 상황이다.
      clockTolerance: 30,
    }));
  } catch (cause) {
    throw new KakaoExchangeError("카카오 ID 토큰 검증에 실패했습니다.", { cause });
  }

  // nonce 검증은 jwtVerify가 해주지 않으므로 직접 한다. 이걸 빠뜨리면
  // 예전에 발급된 id_token을 재사용하는 공격이 통한다.
  if (payload.nonce !== params.expectedNonce) {
    throw new KakaoExchangeError("nonce가 일치하지 않습니다.");
  }

  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new KakaoExchangeError("카카오 ID 토큰에 sub가 없습니다.");
  }

  const nickname = typeof payload.nickname === "string" ? payload.nickname : null;
  return { subject: payload.sub, nickname };
}
