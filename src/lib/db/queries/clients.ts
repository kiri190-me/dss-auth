import "server-only";
import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { clients, userClientGrants } from "@/lib/db/schema";

export type ClientTile = {
  clientId: string;
  name: string;
  description: string | null;
  launcherUrl: string | null;
  launcherIcon: string | null;
};

/**
 * 이 사람이 들어갈 수 있는 시스템 목록. 포털 앱 런처가 쓴다.
 *
 * 여기 보이는 것과 실제 접근 허용은 **같은 판정**이어야 한다. 타일이 보이는데
 * 눌렀더니 거절당하거나, 반대로 안 보이는데 주소를 직접 치면 들어가지는 일이
 * 없어야 한다. 그래서 authorize 엔드포인트도 같은 조건을 쓴다.
 */
export async function listAccessibleClients(userId: string): Promise<ClientTile[]> {
  return db
    .select({
      clientId: clients.clientId,
      name: clients.name,
      description: clients.description,
      launcherUrl: clients.launcherUrl,
      launcherIcon: clients.launcherIcon,
    })
    .from(clients)
    .leftJoin(
      userClientGrants,
      and(
        eq(userClientGrants.clientId, clients.id),
        eq(userClientGrants.userId, userId)
      )
    )
    .where(
      and(
        eq(clients.isActive, true),
        // requiresGrant가 false면 전 직원 공개, true면 부여받은 사람만.
        or(eq(clients.requiresGrant, false), isNotNull(userClientGrants.id))
      )
    )
    .orderBy(asc(clients.sortOrder), asc(clients.name));
}
