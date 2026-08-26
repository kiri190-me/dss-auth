import "server-only";
import { db } from "@/lib/db/client";
import { auditLogs } from "@/lib/db/schema";

type AuditAction = (typeof auditLogs.actionType.enumValues)[number];

export type AuditEntry = {
  /** null이면 시스템이 한 일(행위자가 아직 확정되지 않은 로그인 실패 등). */
  actorUserId?: string | null;
  actionType: AuditAction;
  targetEntity?: string | null;
  targetRecordId?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  clientId?: string | null;
  sourceIp?: string | null;
  userAgent?: string | null;
};

/**
 * 감사 로그 기록.
 *
 * **기록 실패가 본래 작업을 실패시키지 않는다.** 감사 로그를 남기지 못했다는
 * 이유로 로그인을 막으면, 로그 테이블 문제 하나가 전사 로그인 장애가 된다.
 * 대신 서버 콘솔에 남겨 운영자가 알아챌 수 있게 한다.
 *
 * 반대 방향(로그가 더 중요한 경우)이 필요한 곳이 생기면 그때는 호출부에서
 * 명시적으로 await하고 예외를 처리하도록 별도 함수를 만든다.
 */
export async function appendAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorUserId: entry.actorUserId ?? null,
      actionType: entry.actionType,
      targetEntity: entry.targetEntity ?? null,
      targetRecordId: entry.targetRecordId ?? null,
      previousValue: entry.previousValue ?? null,
      newValue: entry.newValue ?? null,
      clientId: entry.clientId ?? null,
      sourceIp: entry.sourceIp ?? null,
      userAgent: entry.userAgent ?? null,
    });
  } catch (error) {
    console.error("[audit] 감사 로그 기록 실패:", entry.actionType, error);
  }
}
