import "server-only";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { appendAuditLog } from "@/lib/db/mutations/audit";
import { clients, userClientGrants } from "@/lib/db/schema";
import { signLogoutToken } from "./logout-token";
import { expandLanPlaceholderToPrimary } from "@/lib/config/lan-address";

/**
 * 세션이 끊겼다는 사실을 각 시스템에 알린다.
 *
 * 왜 필요한가: 포털에서 세션을 폐기해도 각 시스템이 발급한 자기 쿠키는
 * 그대로 살아 있다. 공용 PC에서 "로그아웃"을 눌렀는데 A/S 화면은 계속
 * 열려 있는 상태가 되고, 정지시킨 사람도 자기 세션이 만료될 때까지 계속
 * 일할 수 있다.
 *
 * ⚠️ 통보 실패가 로그아웃을 실패시키지 않는다.
 *
 * A/S가 꺼져 있거나 네트워크가 끊겨 있어도 포털 로그아웃은 되어야 한다 —
 * 통보를 못 보냈다고 로그아웃을 거절하면, 시스템 하나가 죽었을 때 아무도
 * 로그아웃할 수 없게 된다. 대신 감사 로그에 남겨 나중에 볼 수 있게 한다.
 *
 * 남는 구멍은 정직하게 적어 둔다: 통보가 실패하면 그 시스템의 세션은 자기
 * 수명이 다할 때까지 살아 있다. 그래서 각 시스템의 세션 수명이 짧을수록
 * 이 구멍도 작아진다(A/S는 8시간).
 */

/** 한 곳이 느리다고 다른 곳까지 늦어지지 않도록 짧게 끊는다. */
const NOTIFY_TIMEOUT_MS = 5000;

type Target = { clientId: string; uri: string };

/**
 * 이 사람이 들어갈 수 있는 시스템 중, 통보 주소를 등록한 곳.
 *
 * 접근 권한이 없는 시스템에는 보내지 않는다 — 애초에 그 사람의 세션이
 * 있을 수 없고, 보내면 "이 사람이 존재한다"는 사실만 알려주는 꼴이 된다.
 */
async function findTargets(userId: string): Promise<Target[]> {
  const rows = await db
    .select({
      clientId: clients.clientId,
      uri: clients.backchannelLogoutUri,
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
        isNotNull(clients.backchannelLogoutUri),
        // listAccessibleClients와 같은 판정이다. 여기만 다르면 "타일은
        // 안 보이는데 로그아웃 통보는 가는" 이상한 상태가 생긴다.
        or(eq(clients.requiresGrant, false), isNotNull(userClientGrants.id))
      )
    );

  return rows
    .filter((row): row is Target => row.uri !== null)
    // 통보 주소에도 {lan}을 쓸 수 있다. 여기서 펼치지 않으면 주소가 바뀐 뒤
    // 로그아웃 통보만 조용히 실패한다 — 로그인은 되는데 나가지지 않는 상태다.
    .map((target) => ({ ...target, uri: expandLanPlaceholderToPrimary(target.uri) }));
}

async function notifyOne(target: Target, token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  try {
    const response = await fetch(target.uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      // 규격이 정한 형태다 — 폼 인코딩에 logout_token 하나.
      body: new URLSearchParams({ logout_token: token }).toString(),
      signal: controller.signal,
      redirect: "manual",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function notifyBackchannelLogout(params: {
  userId: string;
  sessionId: string;
  /** 감사 로그에 남길 행위자. 관리자가 정지시킨 경우엔 관리자다. */
  actorUserId?: string | null;
  /** 무엇 때문에 끊겼는지. 감사 로그에만 쓴다. */
  reason: "LOGOUT" | "SUSPENDED";
}): Promise<void> {
  let targets: Target[];
  try {
    targets = await findTargets(params.userId);
  } catch (error) {
    console.error("[backchannel] 통보 대상을 찾지 못했습니다:", error);
    return;
  }

  if (targets.length === 0) return;

  // 순서대로 보내지 않고 한꺼번에 보낸다. 한 시스템이 느릴 때 뒤의 시스템이
  // 그만큼 늦게 끊기면, 그 시간이 곧 구멍이다.
  const results = await Promise.all(
    targets.map(async (target) => {
      let token: string;
      try {
        token = await signLogoutToken({
          audience: target.clientId,
          subject: params.userId,
          sessionId: params.sessionId,
        });
      } catch (error) {
        console.error(`[backchannel] 토큰 서명 실패 (${target.clientId}):`, error);
        return { clientId: target.clientId, ok: false };
      }
      return { clientId: target.clientId, ok: await notifyOne(target, token) };
    })
  );

  const failed = results.filter((row) => !row.ok).map((row) => row.clientId);
  if (failed.length === 0) return;

  // 실패는 조용히 넘기지 않는다. 이 줄이 없으면 "로그아웃했는데 저쪽은
  // 아직 열려 있다"를 아무도 모른 채 지나간다.
  console.error(
    `[backchannel] 로그아웃 통보 실패: ${failed.join(", ")} — 그쪽 세션은 만료될 때까지 살아 있습니다.`
  );
  await appendAuditLog({
    actorUserId: params.actorUserId ?? params.userId,
    actionType: "SESSION_REVOKED",
    targetEntity: "sso_sessions",
    targetRecordId: params.sessionId,
    newValue: {
      backchannelFailed: failed,
      reason: params.reason,
      note: "통보를 받지 못한 시스템의 세션은 만료될 때까지 유효합니다.",
    },
  });
}
