"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, ne, sql } from "drizzle-orm";
import { assertPortalAdmin } from "@/lib/auth/portal-admin";
import { db } from "@/lib/db/client";
import { appendAuditLog } from "@/lib/db/mutations/audit";
import { users } from "@/lib/db/schema";

const ADMIN_USERS_PATH = "/admin/users";

/** 빈 문자열은 null로 바꾼다 — DB에 ""과 null이 섞이면 조회 조건이 지저분해진다. */
function text(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function fail(reason: string): never {
  redirect(`${ADMIN_USERS_PATH}?error=${encodeURIComponent(reason)}`);
}

function done(notice: string): never {
  revalidatePath(ADMIN_USERS_PATH);
  redirect(`${ADMIN_USERS_PATH}?ok=${encodeURIComponent(notice)}`);
}

async function loadTarget(userId: string | null) {
  if (!userId) fail("대상을 찾을 수 없습니다.");
  const [row] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      status: users.status,
      isPortalAdmin: users.isPortalAdmin,
      department: users.department,
      employeeNo: users.employeeNo,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) fail("대상을 찾을 수 없습니다.");
  return row;
}

/**
 * 이 사람 말고 다른 활성 포털 관리자가 남아 있는가.
 *
 * 마지막 관리자를 정지하거나 관리자 권한을 빼면 **아무도 포털을 관리할 수
 * 없는 상태**가 된다. 그때는 서버에 들어가 promote-admin 스크립트를 돌리는
 * 수밖에 없는데, 그건 사고 복구지 정상 운영이 아니다. 미리 막는다.
 */
async function hasOtherActiveAdmin(excludeUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        eq(users.isPortalAdmin, true),
        eq(users.status, "ACTIVE"),
        ne(users.id, excludeUserId)
      )
    );
  return (row?.count ?? 0) > 0;
}

/** 승인 대기 사용자를 실명·소속과 함께 승인한다. */
export async function approveUser(formData: FormData) {
  const actor = await assertPortalAdmin();
  const target = await loadTarget(text(formData, "userId"));

  if (target.status !== "PENDING") fail("이미 처리된 사용자입니다.");

  // 실명은 필수다. 카카오 닉네임("길동이")을 그대로 두면 나중에 감사 로그와
  // 각 시스템의 사용자 목록에서 누가 누구인지 알 수 없게 된다.
  const displayName = text(formData, "displayName");
  if (!displayName) fail("실명을 입력해 주세요.");

  const now = new Date();
  await db
    .update(users)
    .set({
      displayName,
      department: text(formData, "department"),
      employeeNo: text(formData, "employeeNo"),
      email: text(formData, "email"),
      status: "ACTIVE",
      approvedAt: now,
      approvedBy: actor.userId,
      updatedAt: now,
    })
    .where(eq(users.id, target.id));

  await appendAuditLog({
    actorUserId: actor.userId,
    actionType: "USER_APPROVED",
    targetEntity: "users",
    targetRecordId: target.id,
    previousValue: { status: target.status, displayName: target.displayName },
    newValue: { status: "ACTIVE", displayName },
  });

  done(`${displayName}님을 승인했습니다.`);
}

/** 이미 등록된 사용자의 실명·소속 등을 고친다. 상태는 건드리지 않는다. */
export async function updateUserProfile(formData: FormData) {
  const actor = await assertPortalAdmin();
  const target = await loadTarget(text(formData, "userId"));

  const displayName = text(formData, "displayName");
  if (!displayName) fail("실명을 입력해 주세요.");

  const next = {
    displayName,
    department: text(formData, "department"),
    employeeNo: text(formData, "employeeNo"),
    email: text(formData, "email"),
  };

  await db
    .update(users)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(users.id, target.id));

  await appendAuditLog({
    actorUserId: actor.userId,
    actionType: "USER_UPDATED",
    targetEntity: "users",
    targetRecordId: target.id,
    previousValue: {
      displayName: target.displayName,
      department: target.department,
      employeeNo: target.employeeNo,
      email: target.email,
    },
    newValue: next,
  });

  done(`${displayName}님의 정보를 수정했습니다.`);
}

/**
 * 계정 정지. 퇴사자 차단의 주 수단이다.
 *
 * 세션을 따로 폐기하지 않아도 즉시 막힌다 — 모든 화면이 매 요청 사용자
 * 상태를 다시 읽기 때문이다(sso-session.ts 참고).
 */
export async function suspendUser(formData: FormData) {
  const actor = await assertPortalAdmin();
  const target = await loadTarget(text(formData, "userId"));

  // 자기 자신을 정지하면 그 순간 관리자 화면에서 튕겨 나간다.
  if (target.id === actor.userId) fail("자기 자신은 정지할 수 없습니다.");
  if (target.status === "SUSPENDED") fail("이미 정지된 사용자입니다.");
  if (target.isPortalAdmin && !(await hasOtherActiveAdmin(target.id))) {
    fail("마지막 포털 관리자는 정지할 수 없습니다. 다른 관리자를 먼저 지정하세요.");
  }

  const now = new Date();
  await db
    .update(users)
    .set({
      status: "SUSPENDED",
      suspendedAt: now,
      suspendReason: text(formData, "reason"),
      updatedAt: now,
    })
    .where(eq(users.id, target.id));

  await appendAuditLog({
    actorUserId: actor.userId,
    actionType: "USER_SUSPENDED",
    targetEntity: "users",
    targetRecordId: target.id,
    previousValue: { status: target.status },
    newValue: { status: "SUSPENDED", reason: text(formData, "reason") },
  });

  done(`${target.displayName}님을 정지했습니다.`);
}

export async function reactivateUser(formData: FormData) {
  const actor = await assertPortalAdmin();
  const target = await loadTarget(text(formData, "userId"));

  if (target.status !== "SUSPENDED") fail("정지 상태가 아닙니다.");

  await db
    .update(users)
    .set({
      status: "ACTIVE",
      suspendedAt: null,
      suspendReason: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, target.id));

  await appendAuditLog({
    actorUserId: actor.userId,
    actionType: "USER_UPDATED",
    targetEntity: "users",
    targetRecordId: target.id,
    previousValue: { status: "SUSPENDED" },
    newValue: { status: "ACTIVE" },
  });

  done(`${target.displayName}님의 정지를 해제했습니다.`);
}

/** 포털 관리자 권한 부여/회수. */
export async function setPortalAdmin(formData: FormData) {
  const actor = await assertPortalAdmin();
  const target = await loadTarget(text(formData, "userId"));
  const grant = formData.get("grant") === "true";

  if (grant && target.status !== "ACTIVE") {
    fail("활성 상태인 사용자에게만 관리자 권한을 줄 수 있습니다.");
  }
  if (!grant) {
    // 자기 권한을 스스로 빼면 즉시 이 화면에 못 들어온다.
    if (target.id === actor.userId) fail("자기 자신의 관리자 권한은 해제할 수 없습니다.");
    if (!(await hasOtherActiveAdmin(target.id))) {
      fail("마지막 포털 관리자의 권한은 해제할 수 없습니다.");
    }
  }
  if (target.isPortalAdmin === grant) fail("이미 그 상태입니다.");

  await db
    .update(users)
    .set({ isPortalAdmin: grant, updatedAt: new Date() })
    .where(eq(users.id, target.id));

  await appendAuditLog({
    actorUserId: actor.userId,
    actionType: "USER_UPDATED",
    targetEntity: "users",
    targetRecordId: target.id,
    previousValue: { isPortalAdmin: target.isPortalAdmin },
    newValue: { isPortalAdmin: grant },
  });

  done(
    grant
      ? `${target.displayName}님에게 관리자 권한을 부여했습니다.`
      : `${target.displayName}님의 관리자 권한을 해제했습니다.`
  );
}
