import "server-only";
import { and, eq } from "drizzle-orm";
import { safeEqual, sha256Hex } from "@/lib/crypto/hash";
import { db } from "@/lib/db/client";
import { clients, userClientGrants } from "@/lib/db/schema";

export type ClientRecord = {
  /** 내부 PK. 외래키에 쓴다. */
  id: string;
  /** 공개 식별자. 인가 요청에 실려 온다. */
  clientId: string;
  name: string;
  clientSecretHash: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  requiresGrant: boolean;
};

/** 비활성 클라이언트는 아예 없는 것으로 취급한다. */
export async function getActiveClient(clientId: string): Promise<ClientRecord | null> {
  if (!clientId) return null;
  const [row] = await db
    .select({
      id: clients.id,
      clientId: clients.clientId,
      name: clients.name,
      clientSecretHash: clients.clientSecretHash,
      redirectUris: clients.redirectUris,
      postLogoutRedirectUris: clients.postLogoutRedirectUris,
      requiresGrant: clients.requiresGrant,
    })
    .from(clients)
    .where(and(eq(clients.clientId, clientId), eq(clients.isActive, true)))
    .limit(1);
  return row ?? null;
}

/**
 * 클라이언트 시크릿 검증.
 *
 * 저장된 것은 sha256 해시뿐이라 평문을 되찾을 수 없다. 비교는
 * timingSafeEqual 기반이다 — 문자열 === 비교는 앞에서부터 다른 지점까지의
 * 시간이 달라, 시크릿을 한 글자씩 알아내는 공격이 이론상 가능하다.
 */
export function verifyClientSecret(record: ClientRecord, presented: string): boolean {
  if (!presented) return false;
  return safeEqual(sha256Hex(presented), record.clientSecretHash);
}

/**
 * 이 사람이 이 시스템에 들어갈 수 있는가.
 *
 * 앱 런처(listAccessibleClients)와 **같은 판정**이어야 한다. 타일이 보이는데
 * 눌렀더니 거절당하거나, 안 보이는데 주소를 직접 치면 들어가지는 일이
 * 없어야 한다.
 */
export async function hasClientAccess(
  userId: string,
  client: ClientRecord
): Promise<boolean> {
  if (!client.requiresGrant) return true;
  const [row] = await db
    .select({ id: userClientGrants.id })
    .from(userClientGrants)
    .where(
      and(
        eq(userClientGrants.userId, userId),
        eq(userClientGrants.clientId, client.id)
      )
    )
    .limit(1);
  return Boolean(row);
}

/**
 * 이 사람이 저 시스템에서 갖는 역할. 없으면 null.
 *
 * 접근 판정(hasClientAccess)과 따로 두는 이유: 역할을 쓰지 않는 시스템도
 * 있고, 전 직원 공개(requiresGrant=false) 시스템은 부여 행 없이도 들어가므로
 * 역할이 없는 것이 정상이다. 두 질문을 한 함수로 합치면 "접근은 되는데
 * 역할이 없다"는 정상 상태를 표현하기 어려워진다.
 */
export async function getClientRole(
  userId: string,
  clientRecordId: string
): Promise<string | null> {
  const [row] = await db
    .select({ role: userClientGrants.role })
    .from(userClientGrants)
    .where(
      and(
        eq(userClientGrants.userId, userId),
        eq(userClientGrants.clientId, clientRecordId)
      )
    )
    .limit(1);
  return row?.role ?? null;
}
