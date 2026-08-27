/**
 * 관리 화면의 시스템 접근 select가 주고받는 특수 값.
 *
 * 서버 액션 파일("use server")은 async 함수만 내보낼 수 있어 상수를 함께
 * 둘 수 없다. 화면과 액션이 같은 문자열을 봐야 하므로 여기로 뺀다.
 *
 * 빈 문자열을 쓰지 않는 이유: FormData는 빈 값과 없는 값을 같게 보내고,
 * select에서도 "권한 없음"과 구분되지 않는다.
 */
export const NO_ACCESS = "__none__";

/** 역할 개념이 없는 시스템에서 "들어갈 수는 있다"를 뜻한다. */
export const GRANTED_NO_ROLE = "__granted__";
