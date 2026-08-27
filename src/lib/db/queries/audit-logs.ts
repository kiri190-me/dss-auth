import "server-only";
import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLogs, users } from "@/lib/db/schema";
import type { AuditAction } from "@/lib/auth/audit-labels";

export type AuditRow = {
  id: string;
  actionType: AuditAction;
  /** 행위자 이름. 시스템이 스스로 한 일이면 null이다. */
  actorName: string | null;
  actorUserId: string | null;
  clientId: string | null;
  previousValue: unknown;
  newValue: unknown;
  sourceIp: string | null;
  userAgent: string | null;
  createdAt: Date;
};

/**
 * 한 화면에 담는 줄 수.
 *
 * 무한 스크롤이나 잘게 나눈 쪽수 대신 큼직하게 한 번에 준다. 감사 기록은
 * 훑어보다 이상한 것을 찾는 화면이라, 조금씩 끊어 보여주면 오히려 놓친다.
 */
export const AUDIT_PAGE_SIZE = 100;

export async function listAuditLogs(params: {
  /** 비어 있으면 전체. */
  actions?: readonly AuditAction[];
  /** 이 시각보다 이전 것만 — 다음 쪽으로 넘어갈 때 쓴다. */
  before?: Date;
  limit?: number;
}): Promise<AuditRow[]> {
  const limit = params.limit ?? AUDIT_PAGE_SIZE;

  const conditions = [];
  if (params.actions && params.actions.length > 0) {
    conditions.push(inArray(auditLogs.actionType, [...params.actions]));
  }
  if (params.before) {
    conditions.push(lt(auditLogs.createdAt, params.before));
  }

  return db
    .select({
      id: auditLogs.id,
      actionType: auditLogs.actionType,
      actorName: users.displayName,
      actorUserId: auditLogs.actorUserId,
      clientId: auditLogs.clientId,
      previousValue: auditLogs.previousValue,
      newValue: auditLogs.newValue,
      sourceIp: auditLogs.sourceIp,
      userAgent: auditLogs.userAgent,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    // leftJoin이어야 한다. actor_user_id가 null인 기록(시스템이 한 일, 아직
    // 사람이 확정되지 않은 로그인 실패)도 보여야 한다 — 오히려 그쪽이
    // 눈여겨볼 줄인 경우가 많다.
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    // 시각이 같은 줄이 있을 수 있어(같은 요청이 두 건을 남기는 경우) id를
    // 덧붙여 순서를 고정한다. 없으면 쪽을 넘길 때 줄이 겹치거나 빠진다.
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit);
}

export type AuditTally = { actionType: AuditAction; n: number };

/**
 * 최근 N일 동안 유형별로 몇 건인지. 화면 맨 위의 요약에 쓴다.
 *
 * 전체 기간이 아니라 최근으로 자르는 이유: 감사 기록은 3년까지 쌓이므로
 * 전체 집계는 "지금 뭔가 이상한가"라는 질문에 답하지 못한다.
 */
export async function tallyRecentAudit(days: number): Promise<AuditTally[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ actionType: auditLogs.actionType, n: count() })
    .from(auditLogs)
    .where(gte(auditLogs.createdAt, since))
    .groupBy(auditLogs.actionType);
  return rows.map((row) => ({ actionType: row.actionType, n: Number(row.n) }));
}

/** 전체 보관 건수와 가장 오래된 기록 — 정리 작업이 도는지 눈으로 확인한다. */
export async function auditStorageSummary(): Promise<{
  total: number;
  oldest: Date | null;
}> {
  const [row] = await db
    .select({
      total: count(),
      oldest: sql<Date | null>`min(${auditLogs.createdAt})`,
    })
    .from(auditLogs);
  return {
    total: Number(row?.total ?? 0),
    oldest: row?.oldest ? new Date(row.oldest) : null,
  };
}
