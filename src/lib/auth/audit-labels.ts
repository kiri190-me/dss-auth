/**
 * 감사 기록을 사람이 읽는 말로 옮기고, 무엇이 눈에 띄어야 하는지 정한다.
 *
 * server-only를 붙이지 않는다 — 순수 표이고, 판정을 테스트로 고정해야 한다.
 * "무엇이 주목할 일인가"는 시간이 지나면 흐려지는 종류의 결정이라, 근거를
 * 코드와 테스트 양쪽에 남겨 둔다.
 */
import type { auditLogs } from "@/lib/db/schema";

export type AuditAction = (typeof auditLogs.actionType.enumValues)[number];

export const AUDIT_LABELS: Record<AuditAction, string> = {
  LOGIN_SUCCESS: "로그인",
  LOGIN_FAILED: "로그인 실패",
  LOGOUT: "로그아웃",
  SESSION_REVOKED: "세션 폐기",
  USER_CREATED: "사용자 생성",
  USER_APPROVED: "사용자 승인",
  USER_SUSPENDED: "사용자 정지",
  USER_UPDATED: "사용자 정보 변경",
  CLIENT_CREATED: "시스템 등록",
  CLIENT_UPDATED: "시스템 정보 변경",
  CLIENT_SECRET_ROTATED: "시스템 시크릿 재발급",
  GRANT_ADDED: "접근 권한 부여",
  GRANT_REMOVED: "접근 권한 회수",
  GRANT_ROLE_CHANGED: "역할 변경",
  TOKEN_ISSUED: "통행증 발급",
  CODE_REPLAY_DETECTED: "인가 코드 재사용 탐지",
  EMERGENCY_LOGIN: "비상 계정 로그인",
  KEY_ROTATED: "서명 키 교체",
};

/**
 * 지나가면 안 되는 일들.
 *
 * 판단 기준은 "이 줄이 눈에 안 띄고 지나갔을 때 나중에 후회하는가"다.
 * 로그인·로그아웃·통행증 발급은 하루에도 수십 건 쌓이는 정상 활동이라
 * 여기 넣으면 진짜 신호가 그 속에 묻힌다.
 *
 * 각각이 왜 여기 있는지:
 *
 *  GRANT_ROLE_CHANGED  — 포털에서 고른 역할이 A/S의 users.role을 그대로
 *      덮어쓴다. 즉 이 한 줄이 누군가를 최고관리자로 만들 수 있다. 이
 *      화면을 만든 가장 큰 이유다.
 *  GRANT_ADDED/REMOVED — 누가 어느 시스템에 닿을 수 있는지가 바뀐 것이다.
 *  EMERGENCY_LOGIN     — 카카오를 거치지 않고 들어온 것이다. 정상적으로는
 *      거의 일어나지 않아야 하고, 일어났다면 이유가 있어야 한다.
 *  CODE_REPLAY_DETECTED— 인가 코드가 두 번 제시됐다. 탈취 또는 구현 오류의
 *      신호다.
 *  USER_SUSPENDED      — 사람을 막은 기록. 누가 언제 막았는지가 남아야 한다.
 *  KEY_ROTATED         — 서명 키가 바뀌면 그 전에 발급된 통행증이 전부
 *      무효가 된다. 모르고 지나가면 "갑자기 아무도 못 들어온다"가 된다.
 *  CLIENT_SECRET_ROTATED — 시스템 하나가 로그인에 실패하기 시작하는 원인이다.
 *  LOGIN_FAILED        — 한두 건은 오타지만, 몰려 있으면 다른 이야기다.
 */
const NOTABLE: ReadonlySet<AuditAction> = new Set<AuditAction>([
  "GRANT_ROLE_CHANGED",
  "GRANT_ADDED",
  "GRANT_REMOVED",
  "EMERGENCY_LOGIN",
  "CODE_REPLAY_DETECTED",
  "USER_SUSPENDED",
  "KEY_ROTATED",
  "CLIENT_SECRET_ROTATED",
  "LOGIN_FAILED",
]);

export function isNotable(action: AuditAction): boolean {
  return NOTABLE.has(action);
}

export function auditLabel(action: AuditAction): string {
  return AUDIT_LABELS[action] ?? action;
}

/**
 * 한 줄을 요약하는 짧은 설명. 유형마다 봐야 할 값이 다르다.
 *
 * 전체 JSON을 그대로 뿌리지 않는 이유: 화면이 읽히지 않게 된다. 유형별로
 * 가장 중요한 한 가지만 뽑고, 나머지는 필요할 때 DB에서 본다.
 */
export function auditSummary(entry: {
  actionType: AuditAction;
  previousValue: unknown;
  newValue: unknown;
  clientId: string | null;
}): string | null {
  const prev = asRecord(entry.previousValue);
  const next = asRecord(entry.newValue);

  switch (entry.actionType) {
    case "GRANT_ROLE_CHANGED": {
      const who = str(next.displayName);
      const from = str(prev.role) ?? "(없음)";
      const to = str(next.role) ?? "(없음)";
      return who ? `${who} · ${from} → ${to}` : `${from} → ${to}`;
    }
    case "GRANT_ADDED":
    case "GRANT_REMOVED": {
      const who = str(next.displayName) ?? str(prev.displayName);
      const role = str(next.role) ?? str(prev.role);
      if (who && role) return `${who} · ${role}`;
      return who ?? null;
    }
    case "LOGIN_FAILED": {
      const reason = str(next.reason);
      const via = str(next.via);
      if (reason && via) return `${via} · ${reason}`;
      return reason ?? via ?? null;
    }
    case "LOGIN_SUCCESS": {
      const method = str(next.method);
      return next.isNewUser === true ? `${method ?? ""} · 첫 로그인`.trim() : method;
    }
    case "USER_APPROVED":
      return str(next.displayName) ?? null;
    case "EMERGENCY_LOGIN":
      return str(next.displayName) ?? null;
    case "USER_CREATED":
      return str(next.displayName) ?? str(next.via) ?? null;
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
