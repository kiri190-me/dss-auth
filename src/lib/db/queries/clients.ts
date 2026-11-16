import "server-only";
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
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
  return rows.map(expandTile);
}

/**
 * 이름으로 고른 시스템 목록. 🔴 **사람을 보지 않는다 — 그것이 윗 함수와 다른 전부다.**
 *
 * 🔴 **접근 권한으로 거르면 안 되는 자리가 있다.** 결재권 위임 전파가 그것이다
 * (approvals/delegation-push.ts): 위임은 **누가 눌렀느냐와 무관하게** 세 시스템 전부에
 * 걸리고(표 머리말 — `scope` 칸을 두지 않는다), 맡기는 사람과 맡는 사람은 **부른 사람과
 * 다를 수 있다**(관리자가 남의 결재권을 맡긴다). 여기에 `listAccessibleClients` 를 쓰면
 * 「부른 사람이 재고관리에 못 들어간다는 이유로 **재고관리에만** 위임이 안 걸리는」 일이
 * 생기고, 오류는 한 줄도 안 난다.
 *
 * 🔵 「그 시스템에 그 사람이 있는가」는 **받는 쪽이** 답한다(`not_applicable`). 포털이
 * 대신 짐작하지 않는다.
 *
 * 🔴 **꺼 둔 클라이언트(`is_active = false`)는 빠진다** — 윗 함수와 같은 조건이다.
 * 부르는 쪽은 빠진 것을 「갈 수 없는 곳」으로 세고 전파를 실패로 본다
 * (sources.ts 의 `planDelegationPush` — `not_registered`).
 */
export async function listClientsByClientIds(
  clientIds: readonly string[]
): Promise<ClientTile[]> {
  // 🔵 빈 `IN ()` 은 드라이버마다 다르게 돈다. 부를 일이 없는 값이지만 막아 둔다.
  if (clientIds.length === 0) return [];

  const rows = await db
    .select({
      clientId: clients.clientId,
      name: clients.name,
      description: clients.description,
      launcherUrl: clients.launcherUrl,
      launcherIcon: clients.launcherIcon,
    })
    .from(clients)
    .where(and(eq(clients.isActive, true), inArray(clients.clientId, [...clientIds])))
    .orderBy(asc(clients.sortOrder), asc(clients.name));

  return rows.map(expandTile);
}

/**
 * `{lan}` 을 이 기계의 주소로 펼친다. 🔵 조회 둘이 **같은 값**을 내주게 하려고 뺐다 —
 * 한쪽만 펼치면 그 길로만 가는 요청이 `{lan}` 이 박힌 주소로 나간다.
 */
function expandTile(row: ClientTile): ClientTile {
  return {
    ...row,
    launcherUrl:
      row.launcherUrl === null ? null : expandLanPlaceholderToPrimary(row.launcherUrl),
  };
}
