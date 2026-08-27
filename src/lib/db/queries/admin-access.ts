import "server-only";
import { asc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { clients, userClientGrants } from "@/lib/db/schema";

export type AdminClientRow = {
  id: string;
  clientId: string;
  name: string;
  requiresGrant: boolean;
  isActive: boolean;
  availableRoles: string[];
};

export type AdminGrantRow = {
  userId: string;
  clientId: string;
  role: string | null;
};

/** 관리 화면이 시스템별 칸을 그리기 위한 목록. */
export async function listClientsForAdmin(): Promise<AdminClientRow[]> {
  return db
    .select({
      id: clients.id,
      clientId: clients.clientId,
      name: clients.name,
      requiresGrant: clients.requiresGrant,
      isActive: clients.isActive,
      availableRoles: clients.availableRoles,
    })
    .from(clients)
    .orderBy(asc(clients.sortOrder), asc(clients.name));
}

/**
 * 부여 전체를 한 번에 읽는다.
 *
 * 사용자마다 조회하지 않는 이유: 관리 화면은 사용자 수 × 시스템 수만큼의
 * 칸을 그리는데, 사용자별로 조회하면 화면 한 번에 조회가 사용자 수만큼
 * 나간다. 두 표 모두 한 자릿수~두 자릿수 규모라 통째로 읽어 메모리에서
 * 맞추는 편이 단순하고 빠르다.
 */
export async function listGrantsForAdmin(): Promise<AdminGrantRow[]> {
  return db
    .select({
      userId: userClientGrants.userId,
      clientId: userClientGrants.clientId,
      role: userClientGrants.role,
    })
    .from(userClientGrants);
}

/** "userId:clientId" → 부여 내용. 화면이 칸마다 현재 값을 찾을 때 쓴다. */
export function indexGrants(rows: AdminGrantRow[]): Map<string, AdminGrantRow> {
  return new Map(rows.map((row) => [`${row.userId}:${row.clientId}`, row]));
}
