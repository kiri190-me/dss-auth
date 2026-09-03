import "server-only";
import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { clients, userClientGrants } from "@/lib/db/schema";
import { expandLanPlaceholderToPrimary } from "@/lib/config/lan-address";

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
  const rows = await db
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

  // 런처 주소도 {lan}을 쓸 수 있다. 타일을 누르는 사람이 폰이든 PC든
  // 지금 이 기계의 주소로 간다 — 주소가 바뀌어도 링크가 따라온다.
  return rows.map((row) => ({
    ...row,
    launcherUrl:
      row.launcherUrl === null
        ? null
        : expandLanPlaceholderToPrimary(row.launcherUrl),
  }));
}
