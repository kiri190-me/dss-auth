"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import {
  GRANTED_NO_ROLE,
  NO_ACCESS,
} from "@/lib/auth/client-access-values";
import { assertPortalAdmin } from "@/lib/auth/portal-admin";
import { db } from "@/lib/db/client";
import { appendAuditLog } from "@/lib/db/mutations/audit";
import { clients, userClientGrants, users } from "@/lib/db/schema";

const ADMIN_USERS_PATH = "/admin/users";

function fail(reason: string): never {
  redirect(`${ADMIN_USERS_PATH}?error=${encodeURIComponent(reason)}`);
}

function done(notice: string): never {
  revalidatePath(ADMIN_USERS_PATH);
  redirect(`${ADMIN_USERS_PATH}?ok=${encodeURIComponent(notice)}`);
}

function field(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * 이 사람이 저 시스템에 들어갈 수 있는지, 그리고 어떤 역할인지를 정한다.
 *
 * ⚠️ 여기서 정한 역할은 받는 시스템의 권한을 그대로 결정한다. A/S 관리
 * 시스템은 로그인할 때마다 이 값으로 자기 users.role을 덮어쓴다. 즉 이
 * 화면에서 SUPER_ADMIN을 고르면 그 사람은 다음 로그인에 A/S 최고관리자가
 * 된다. 포털 관리자만 이 액션을 부를 수 있도록 막는 것이 그래서 중요하다.
 */
export async function setClientAccess(formData: FormData) {
  const actor = await assertPortalAdmin();

  const userId = field(formData, "userId");
  const clientRecordId = field(formData, "clientId");
  const value = field(formData, "value");

  if (!userId || !clientRecordId || !value) fail("대상을 찾을 수 없습니다.");

  const [target] = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) fail("대상을 찾을 수 없습니다.");

  const [client] = await db
    .select({
      id: clients.id,
      clientId: clients.clientId,
      name: clients.name,
      availableRoles: clients.availableRoles,
    })
    .from(clients)
    .where(eq(clients.id, clientRecordId))
    .limit(1);
  if (!client) fail("시스템을 찾을 수 없습니다.");

  // 화면이 보내온 값이라도 믿지 않는다. 서버 액션은 화면을 거치지 않고
  // 직접 호출될 수 있으므로, 역할이 그 시스템의 목록에 있는지 여기서 다시
  // 확인한다(portal-admin.ts가 화면 가드와 액션 가드를 따로 두는 것과 같은
  // 이유다).
  const isRole = value !== NO_ACCESS && value !== GRANTED_NO_ROLE;
  if (isRole && !client.availableRoles.includes(value)) {
    fail(`"${value}" 은(는) ${client.name}의 역할이 아닙니다.`);
  }
  if (value === GRANTED_NO_ROLE && client.availableRoles.length > 0) {
    fail(`${client.name}은(는) 역할을 지정해야 합니다.`);
  }

  const [existing] = await db
    .select({ id: userClientGrants.id, role: userClientGrants.role })
    .from(userClientGrants)
    .where(
      and(
        eq(userClientGrants.userId, target.id),
        eq(userClientGrants.clientId, client.id)
      )
    )
    .limit(1);

  // ───── 회수 ─────

  if (value === NO_ACCESS) {
    if (!existing) done(`${target.displayName}님은 이미 ${client.name} 권한이 없습니다.`);

    await db.delete(userClientGrants).where(eq(userClientGrants.id, existing.id));
    await appendAuditLog({
      actorUserId: actor.userId,
      actionType: "GRANT_REMOVED",
      targetEntity: "user_client_grants",
      targetRecordId: existing.id,
      previousValue: {
        userId: target.id,
        displayName: target.displayName,
        role: existing.role,
      },
      clientId: client.clientId,
    });

    done(`${target.displayName}님의 ${client.name} 권한을 회수했습니다.`);
  }

  const nextRole = isRole ? value : null;

  // ───── 역할 변경 ─────

  if (existing) {
    if (existing.role === nextRole) {
      done(`${target.displayName}님의 ${client.name} 설정은 이미 그대로입니다.`);
    }

    await db
      .update(userClientGrants)
      .set({ role: nextRole })
      .where(eq(userClientGrants.id, existing.id));
    await appendAuditLog({
      actorUserId: actor.userId,
      actionType: "GRANT_ROLE_CHANGED",
      targetEntity: "user_client_grants",
      targetRecordId: existing.id,
      previousValue: { role: existing.role },
      newValue: {
        role: nextRole,
        userId: target.id,
        displayName: target.displayName,
      },
      clientId: client.clientId,
    });

    done(
      `${target.displayName}님의 ${client.name} 역할을 ${nextRole ?? "(없음)"}(으)로 바꿨습니다. 다음 로그인부터 반영됩니다.`
    );
  }

  // ───── 새로 부여 ─────

  const [inserted] = await db
    .insert(userClientGrants)
    .values({
      userId: target.id,
      clientId: client.id,
      role: nextRole,
      grantedBy: actor.userId,
    })
    .returning({ id: userClientGrants.id });

  await appendAuditLog({
    actorUserId: actor.userId,
    actionType: "GRANT_ADDED",
    targetEntity: "user_client_grants",
    targetRecordId: inserted.id,
    newValue: {
      userId: target.id,
      displayName: target.displayName,
      role: nextRole,
    },
    clientId: client.clientId,
  });

  done(
    nextRole
      ? `${target.displayName}님에게 ${client.name} 권한을 주었습니다. (${nextRole})`
      : `${target.displayName}님에게 ${client.name} 권한을 주었습니다.`
  );
}
