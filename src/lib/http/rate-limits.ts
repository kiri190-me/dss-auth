import "server-only";
import { trustedProxyHops } from "@/lib/config/env";
import { rateLimitKey } from "./client-key";
import { createRateLimiter, type RateLimitDecision } from "./rate-limit";

/**
 * 어디에 얼마를 걸 것인가.
 *
 * 이 파일만 server-only다 — 여기 있는 한도는 프로세스 전체가 공유하는
 * **하나의 상태**라, 요청마다 새로 만들어지면 아무것도 막지 못한다.
 * 판정 자체는 rate-limit.ts에 순수 함수로 있고 그쪽이 테스트를 갖는다.
 *
 * 숫자는 "정상 사용자가 절대 닿지 않고, 공격자는 반드시 닿는" 자리에 둔다.
 * 각 한도의 근거는 아래 주석에 개별로 적었다.
 */

/**
 * 비상 로그인 — 가장 좁게 건다.
 *
 * 이 경로만 scrypt를 태운다(실측 62ms, 32MB). 제한이 없으면 자격증명 없이
 * POST를 반복하는 것만으로 서버를 멈출 수 있고, 포털이 멈추면 포털에 기대는
 * 모든 사내 시스템의 로그인이 함께 멈춘다.
 *
 * 분당 10회면 CPU 부담은 개발 PC에서 0.62초/분(약 1%), NAS의 Celeron
 * J3355에서도 2~3% 수준이다. 사람 쪽으로는 넉넉하다 — 계정 잠금이 이미
 * 5회에서 걸리고, 인증 코드를 빈 칸으로 보낸 왕복은 실패로 세지 않으므로
 * (emergency-login.ts 참고) 실제로 필요한 시도 수는 10회에 한참 못 미친다.
 */
export const emergencyLoginLimiter = createRateLimiter({
  capacity: 10,
  refillPerMinute: 10,
});

/**
 * 토큰 엔드포인트.
 *
 * 사람이 아니라 각 시스템의 서버가 부른다. 로그인 1회에 정확히 1번 불리므로
 * 정상 사용량은 사내 인원 수를 넘지 않는다. 분당 120회는 그 수십 배다.
 *
 * 시크릿 자체는 32바이트 랜덤이라 추측으로 뚫리지 않지만(hash.ts 참고),
 * 이 엔드포인트는 요청마다 DB 조회와 코드 소비 트랜잭션을 돈다. 막는 대상은
 * 시크릿 추측이 아니라 그 DB 작업의 반복이다.
 */
export const tokenEndpointLimiter = createRateLimiter({
  capacity: 30,
  refillPerMinute: 120,
});

/**
 * 인가 엔드포인트.
 *
 * 사람의 브라우저가 부르고 요청마다 DB를 여러 번 읽는다. 한도를 넉넉히 잡은
 * 이유: 지금은 TRUSTED_PROXY_HOPS=0이라 **모든 사용자가 이 한 통을 함께
 * 쓴다.** 아침 출근 시간에 전 직원이 동시에 로그인해도 닿지 않아야 한다
 * (30명이 5분 안에 들어와도 분당 6회다).
 *
 * 그래도 걸어 두는 이유는 무한 리다이렉트 고리 때문이다 — 클라이언트 설정이
 * 틀어지면 authorize와 클라이언트 사이를 초당 수십 번 왕복하는 일이 생기고,
 * 그때 이 한도가 고리를 끊는다.
 */
export const authorizeEndpointLimiter = createRateLimiter({
  capacity: 60,
  refillPerMinute: 120,
});

/**
 * 이 요청이 쓸 열쇠. 프록시가 없으면 모두 같은 열쇠를 받는다(client-key.ts).
 *
 * 서버 액션은 Request 객체가 없고 next/headers의 headers()를 쓰므로,
 * Request가 아니라 헤더 값을 직접 받는다.
 */
export function keyForForwardedFor(forwardedFor: string | null): string {
  return rateLimitKey(forwardedFor, trustedProxyHops());
}

export function keyForRequest(request: Request): string {
  return keyForForwardedFor(request.headers.get("x-forwarded-for"));
}

export type { RateLimitDecision };
