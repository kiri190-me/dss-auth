import {
  PORTAL_SERVICE_TOKEN_PURPOSES,
  type PortalServiceTokenPurpose,
} from "@/lib/oidc/service-token";
import {
  emptyFeed,
  mergeSourceOutcomes,
  parseSourceFeed,
  type PortalNotificationFeed,
  type SourceOutcome,
} from "./merge";
import {
  emptySettings,
  messageFrom,
  parseSettingsPayload,
  unavailableSystem,
  type PortalSettingsChange,
  type PortalSettingsOverview,
  type PortalSettingsSaveResult,
  type PortalSettingsSystem,
} from "./settings";
import type { NotificationSource } from "./sources";

/**
 * ============================================================================
 * 여러 시스템에 **동시에** 묻는다 — 하나가 죽어도 나머지는 나온다
 * ============================================================================
 * 백채널 로그아웃(oidc/backchannel-logout.ts)의 관례를 그대로 따른다. 설계서
 * F-8 이 「그것을 따르라」고 적은 자리다:
 *
 *  · **한꺼번에 보낸다.** 순서대로 물으면 앞의 시스템이 느릴 때 뒤의 시스템이
 *    그만큼 늦는다. 종이 뜨는 시간은 가장 느린 한 곳만큼만이어야 한다.
 *  · **짧게 끊는다.** 아래 상수.
 *  · **실패를 삼킨다.** 🔴 종이 통째로 안 뜨는 것이 가장 나쁘다. 못 물어본
 *    시스템은 목록에서 빠지고, 그 사실만 `degraded`·`sources` 로 남는다.
 *  · **조용히 넘기지는 않는다.** 서버 로그에 한 줄 남긴다 — 이 줄이 없으면
 *    「어제부터 A/S 알림이 안 온다」를 아무도 모른 채 지나간다.
 *
 * ── 왜 fetch 와 서명을 인자로 받는가 ────────────────────────────────────────
 * 이 파일의 값어치는 **죽었을 때·느릴 때** 제대로 도는가에 있다. 그것을 실제
 * 서버로 시험할 수는 없으므로 둘 다 갈아 끼울 수 있게 두었다. server-only 를
 * 붙이지 않은 이유도 같다(lan-address.ts 와 같은 모양).
 * ============================================================================
 */

/**
 * 읽기 타임아웃 1.5초.
 *
 * A/S 쪽 실측은 약 13ms 다. 이 값은 **느린 것**을 위한 값이 아니라 **죽었을
 * 때**를 위한 값이다 — 답이 없는 상대를 기다리는 시간이 곧 종이 안 뜨는
 * 시간이다. 백채널 로그아웃의 5초보다 짧게 잡은 것은 저쪽은 사람이 기다리지
 * 않는 뒷일이고 이쪽은 사람이 종을 누르고 보고 있기 때문이다.
 */
export const READ_TIMEOUT_MS = 1500;

/**
 * 쓰기 타임아웃 5초. 백채널 로그아웃과 같은 값.
 *
 * 저장은 저쪽에서 트랜잭션 한 번이 도는 일이고, 사람이 「저장」을 누르고
 * 기다리는 중이다. 읽기와 같은 1.5초로 끊으면 **성공한 저장을 실패로 보여
 * 주는** 일이 생기는데, 그게 제일 나쁘다 — 사람이 다시 누른다.
 */
export const WRITE_TIMEOUT_MS = 5000;

/** 주체(사람)는 부르는 쪽이 이미 쥐고 있다. 여기서는 어디에 무엇을 하러 가는지만 정한다. */
export type SignServiceToken = (params: {
  audience: string;
  purpose: PortalServiceTokenPurpose;
}) => Promise<string>;

export type GatherDeps = {
  signToken: SignServiceToken;
  /** 시험이 갈아 끼운다. 평소에는 전역 fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type AskResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; reason: string };

/**
 * 한 곳에 한 번 묻는다. 🔴 **던지지 않는다.**
 *
 * `redirect: "manual"` 인 것이 중요하다 — 리다이렉트를 따라가면 `Authorization`
 * 머리말에 실린 토큰이 저쪽이 고른 주소로 그대로 따라간다. 백채널 로그아웃이
 * 같은 값을 쓰는 이유이기도 하다.
 *
 * 응답 본문을 타임아웃 **안에서** 읽는다. 머리말만 빨리 주고 본문을 안 주는
 * 상대에게 걸리면 그 자리에서 멈추기 때문이다.
 */
async function ask(params: {
  url: string;
  token: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  method: "GET" | "PUT";
  body?: string;
}): Promise<AskResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await params.fetchImpl(params.url, {
      method: params.method,
      headers: {
        authorization: `Bearer ${params.token}`,
        accept: "application/json",
        ...(params.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: params.body,
      signal: controller.signal,
      redirect: "manual",
      // 알림은 사람마다 다르고 매번 새로 계산된다. 중간 어디에도 남으면 안 된다.
      cache: "no-store",
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // 본문이 깨졌어도 상태 코드는 뜻이 있다(403·404 는 본문 없이도 읽힌다).
      body = null;
    }
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

/** 서명까지 포함해 한 번 묻는다. 서명 실패도 「못 물어봤다」로 돌아온다. */
async function askWithToken(params: {
  source: NotificationSource;
  url: string;
  purpose: PortalServiceTokenPurpose;
  method: "GET" | "PUT";
  body?: string;
  deps: GatherDeps;
  timeoutMs: number;
}): Promise<AskResult> {
  let token: string;
  try {
    token = await params.deps.signToken({
      audience: params.source.clientId,
      purpose: params.purpose,
    });
  } catch (error) {
    console.error(`[notifications] 토큰 서명 실패 (${params.source.clientId}):`, error);
    return { ok: false, reason: "sign_failed" };
  }

  return ask({
    url: params.url,
    token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.deps.fetchImpl ?? fetch,
    method: params.method,
    body: params.body,
  });
}

// ─────────────────────────────────────────────────────────────── 알림 목록

/**
 * 「이 사람의 지금 알림」을 모든 시스템에 동시에 묻고 합친다.
 *
 * 🔴 **빈 목록은 정상이다.** A/S 쪽 실측에서 활성 사용자 12명 중 포털 계정과
 * 이어진 사람은 4명이었다(설계서 F-3). 계정이 없는 사람에게 A/S 는 200 과 빈
 * 목록으로 답한다 — 그것을 오류로 그리면 대부분의 사람이 빨간 종을 본다.
 */
export async function gatherNotifications(
  params: { sources: readonly NotificationSource[] } & GatherDeps
): Promise<PortalNotificationFeed> {
  if (params.sources.length === 0) return emptyFeed();

  const timeoutMs = params.timeoutMs ?? READ_TIMEOUT_MS;

  const outcomes = await Promise.all(
    params.sources.map(async (source): Promise<SourceOutcome> => {
      const result = await askWithToken({
        source,
        url: source.notificationsUrl,
        purpose: PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead,
        method: "GET",
        deps: params,
        timeoutMs,
      });

      if (!result.ok) {
        console.error(
          `[notifications] ${source.clientId} 에 묻지 못했습니다 (${result.reason}). 그 시스템의 알림은 이번에 빠집니다.`
        );
        return { source, ok: false };
      }
      if (result.status !== 200) {
        console.error(
          `[notifications] ${source.clientId} 가 ${result.status} 로 답했습니다. 그 시스템의 알림은 이번에 빠집니다.`
        );
        return { source, ok: false };
      }

      return { source, ok: true, feed: parseSourceFeed(result.body, source) };
    })
  );

  return mergeSourceOutcomes(outcomes);
}

// ─────────────────────────────────────────────────────────────── 알림 설정

/**
 * 각 시스템의 알림 설정을 모아 온다.
 *
 * 🔴 403 을 **정상 응답으로** 담는다. A/S 는 관리자 이상만 이 표를 내주므로,
 * 관리자가 아닌 사람에게 403 은 고장이 아니라 답이다.
 */
export async function gatherNotificationSettings(
  params: { sources: readonly NotificationSource[] } & GatherDeps
): Promise<PortalSettingsOverview> {
  if (params.sources.length === 0) return emptySettings();

  const timeoutMs = params.timeoutMs ?? READ_TIMEOUT_MS;

  const systems = await Promise.all(
    params.sources.map(async (source): Promise<PortalSettingsSystem> => {
      const result = await askWithToken({
        source,
        url: source.settingsUrl,
        purpose: PORTAL_SERVICE_TOKEN_PURPOSES.notificationSettingsRead,
        method: "GET",
        deps: params,
        timeoutMs,
      });

      if (!result.ok) {
        console.error(`[notifications] ${source.clientId} 설정을 읽지 못했습니다 (${result.reason}).`);
        return unavailableSystem(source, "지금은 이 시스템의 설정을 불러올 수 없습니다.");
      }

      if (result.status === 403) {
        return {
          clientId: source.clientId,
          name: source.name,
          status: "forbidden",
          message: messageFrom(result.body, "이 시스템의 알림 설정을 볼 권한이 없습니다."),
        };
      }

      if (result.status !== 200) {
        // 401 이면 우리 토큰이 거절된 것이다 — 설정이 어긋났다는 뜻이라 크게 남긴다.
        // 404 는 그 시스템이 지금 이 통로를 열지 않은 상태다(A/S 의 not_enabled).
        console.error(
          `[notifications] ${source.clientId} 설정 통로가 ${result.status} 로 답했습니다.`
        );
        return unavailableSystem(source, "지금은 이 시스템의 설정을 불러올 수 없습니다.");
      }

      const parsed = parseSettingsPayload(result.body);
      if (!parsed) {
        console.error(`[notifications] ${source.clientId} 설정 답의 모양이 다릅니다.`);
        return unavailableSystem(source, "이 시스템의 설정을 읽을 수 없습니다.");
      }

      return {
        clientId: source.clientId,
        name: source.name,
        status: "ok",
        roles: parsed.roles,
        kinds: parsed.kinds,
      };
    })
  );

  return {
    systems,
    // 🔴 forbidden 은 세지 않는다. 권한이 없는 것은 고장이 아니다.
    degraded: systems.some((system) => system.status === "unavailable"),
  };
}

/**
 * 바꾼 설정을 **그 시스템으로 되돌려 보낸다.**
 *
 * 포털은 값을 갖지 않는다(설계서 D-5). 저장도 판정도 저쪽에서 일어나고,
 * 여기서는 답을 사람이 읽을 수 있는 모양으로 옮길 뿐이다.
 */
export async function pushNotificationSettings(
  params: { source: NotificationSource; changes: PortalSettingsChange[] } & GatherDeps
): Promise<PortalSettingsSaveResult> {
  const result = await askWithToken({
    source: params.source,
    url: params.source.settingsUrl,
    purpose: PORTAL_SERVICE_TOKEN_PURPOSES.notificationSettingsWrite,
    method: "PUT",
    body: JSON.stringify({ changes: params.changes }),
    deps: params,
    timeoutMs: params.timeoutMs ?? WRITE_TIMEOUT_MS,
  });

  if (!result.ok) {
    console.error(
      `[notifications] ${params.source.clientId} 에 설정을 보내지 못했습니다 (${result.reason}).`
    );
    return { status: "unavailable", message: "지금은 이 시스템에 저장할 수 없습니다." };
  }

  if (result.status === 200) {
    const changedCount = (result.body as { changedCount?: unknown } | null)?.changedCount;
    return {
      status: "ok",
      changedCount: typeof changedCount === "number" ? changedCount : 0,
    };
  }
  if (result.status === 403) {
    return {
      status: "forbidden",
      message: messageFrom(result.body, "이 시스템의 알림 설정을 바꿀 권한이 없습니다."),
    };
  }
  if (result.status === 400) {
    return {
      status: "invalid",
      message: messageFrom(result.body, "보낸 값을 그 시스템이 받아들이지 않았습니다."),
    };
  }

  console.error(
    `[notifications] ${params.source.clientId} 저장 통로가 ${result.status} 로 답했습니다.`
  );
  return { status: "unavailable", message: "지금은 이 시스템에 저장할 수 없습니다." };
}
