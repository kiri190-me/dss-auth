/**
 * 무엇을 언제까지 남겨 둘 것인가.
 *
 * server-only를 붙이지 않는다 — 순수 계산이고, 이 저장소의 테스트에서 그대로
 * 불러야 한다(crypto/hash.ts와 같은 이유). 실제로 지우는 쪽은
 * scripts/purge-expired.ts가 맡는다.
 *
 * 왜 필요한가: 지금은 지우는 코드가 없어서 다 쓴 인가 코드와 만료된 토큰이
 * 영원히 쌓인다. 개발 몇 시간 만에 인가 코드 20건 중 20건이 만료 상태였다.
 * 그리고 감사 로그의 "보관 3년"은 스키마 주석에만 있고 구현이 없어, 실제로는
 * 영구 보관이다 — source_ip와 user_agent를 의도보다 오래 갖고 있게 된다.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 인가 코드: 만료 후 7일.
 *
 * 만료 즉시 지우면 안 된다. consumedAt은 행을 지우는 대신 남기는 표시이고,
 * 그 표시가 있어야 재사용 공격과 단순 오타를 구분할 수 있다(스키마 주석 참조).
 * 코드 수명이 60초이므로 실제 재사용 시도는 몇 분 안에 오지만, 사고를 뒤늦게
 * 조사할 때 지난주 것을 볼 수 있어야 한다.
 */
export const AUTHORIZATION_CODE_RETENTION_DAYS = 7;

/**
 * 액세스 토큰: 만료 후 7일.
 *
 * 만료된 토큰은 검증에 쓰이지 않으므로 기능상 지워도 된다. 인가 코드와 같은
 * 기간을 쓰는 이유는 하나의 사건(코드 재사용 → 토큰 폐기)이 두 표에 걸쳐
 * 남기 때문이다. 한쪽만 먼저 사라지면 그 사건이 반쪽만 남는다.
 */
export const ACCESS_TOKEN_RETENTION_DAYS = 7;

/**
 * SSO 세션: 만료·폐기 후 30일.
 *
 * 더 길게 잡은 이유: 한 사람이 하루에 한두 행만 만들어 양이 적고,
 * "그때 누가 로그인해 있었나"는 나중에 물어보게 되는 종류의 질문이다.
 */
export const SSO_SESSION_RETENTION_DAYS = 30;

/**
 * 감사 로그: 3년.
 *
 * 스키마 주석이 선언한 값을 그대로 가져왔다. 지금까지 그 선언을 지키는 코드가
 * 없었으므로, 이 상수가 생긴 것 자체가 이번 변경의 요점이다.
 *
 * 윤년 때문에 정확히 3년이 되지는 않는다. 보관 정책에서 하루 이틀의 차이는
 * 의미가 없고, 대신 계산이 단순해 설명하기 쉽다.
 */
export const AUDIT_LOG_RETENTION_DAYS = 365 * 3;

export type RetentionCutoffs = {
  /** 이 시각보다 먼저 만료된 인가 코드는 지운다. */
  authorizationCodes: Date;
  accessTokens: Date;
  /** 이 시각보다 먼저 만료·폐기된 세션은 지운다. */
  ssoSessions: Date;
  /** 이 시각보다 먼저 기록된 감사 로그는 지운다. */
  auditLogs: Date;
};

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * 기준 시각을 인자로 받는다 — Date.now()를 안에서 부르면 테스트가 시계에
 * 의존하게 되고, 지우는 쪽에서도 한 번의 실행이 여러 기준 시각을 쓰게 된다.
 */
export function retentionCutoffs(now: Date): RetentionCutoffs {
  return {
    authorizationCodes: daysBefore(now, AUTHORIZATION_CODE_RETENTION_DAYS),
    accessTokens: daysBefore(now, ACCESS_TOKEN_RETENTION_DAYS),
    ssoSessions: daysBefore(now, SSO_SESSION_RETENTION_DAYS),
    auditLogs: daysBefore(now, AUDIT_LOG_RETENTION_DAYS),
  };
}
