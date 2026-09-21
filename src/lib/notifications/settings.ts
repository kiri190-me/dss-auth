import type { NotificationSource } from "./sources";

/**
 * ============================================================================
 * 알림 **설정** — 포털은 그리기만 하고, 값의 주인은 각 시스템이다
 * ============================================================================
 * 설계 결정(2026-09-21, 설계서 D-5): **화면만 포털로 옮기고 자료는 각 시스템이
 * 계속 갖는다.** 알림 종류도 역할도 그 시스템 고유의 것이라, 포털이 그것을
 * 가지면 시스템이 늘 때마다 포털을 고쳐 배포해야 한다.
 *
 * 그래서 이 파일의 타입은 **그리는 데 필요한 모양**일 뿐, 뜻을 담지 않는다.
 * 역할 이름도 종류 이름도 각 시스템이 글자로 함께 보내 준다 — 포털에 코드표가
 * 없어야 A/S 가 역할을 하나 늘릴 때 포털이 가만히 있어도 된다.
 *
 * 🔴 **403 은 정상 응답의 하나다.** A/S 는 설정 읽기·쓰기 둘 다 관리자 이상만
 * 허용한다. 관리자가 아닌 사람이 이 화면을 열면 「그 시스템은 볼 수 없다」가
 * 답이지 고장이 아니다. 못 물어본 것(unavailable)과 섞지 않으려고 status 를
 * 셋으로 나눠 두었다.
 * ============================================================================
 */

/** 그 시스템의 역할 한 줄. `editable` 이 false 면 화면이 그 줄을 잠근다. */
export type PortalSettingsRole = {
  code: string;
  label: string;
  editable: boolean;
};

/** 종류 × 역할 한 칸. 기본값을 함께 받아 「기본에서 바뀐 칸」을 표시할 수 있다. */
export type PortalSettingsRoleCell = {
  receives: boolean;
  defaultReceives: boolean;
};

/** 알림 종류 한 줄. */
export type PortalSettingsKind = {
  kind: string;
  label: string;
  description: string;
  enabled: boolean;
  defaultEnabled: boolean;
  /** 열쇠는 위 역할의 `code`. */
  roles: Record<string, PortalSettingsRoleCell>;
};

export type PortalSettingsSystem = {
  clientId: string;
  name: string;
} & (
  | { status: "ok"; roles: PortalSettingsRole[]; kinds: PortalSettingsKind[] }
  /** 🔴 권한이 없어 못 본다. 고장이 아니다. */
  | { status: "forbidden"; message: string }
  /** 못 물어봤다(죽었거나·느렸거나·답이 깨졌거나). */
  | { status: "unavailable"; message: string }
);

export type PortalSettingsOverview = {
  systems: PortalSettingsSystem[];
  /** 🔴 forbidden 은 여기 세지 않는다 — 정상 응답이다. */
  degraded: boolean;
};

/** 저장 요청 한 줄. 포털은 모양만 보고 그대로 그 시스템에 넘긴다. */
export type PortalSettingsChange = {
  kind: string;
  enabled: boolean;
  roles: Record<string, boolean>;
};

export type PortalSettingsSaveResult =
  | { status: "ok"; changedCount: number }
  | { status: "forbidden"; message: string }
  | { status: "invalid"; message: string }
  | { status: "unavailable"; message: string };

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * 받은 설정 답을 훑는다. 🔴 던지지 않는다 — 모양이 깨졌으면 null 이고, 부르는
 * 쪽이 그 시스템을 unavailable 로 적는다.
 *
 * 한 줄이라도 이상하면 **그 시스템 전체를 버린다.** 알림 목록과 반대인데,
 * 까닭이 있다: 설정은 사람이 켜고 끄는 표라 일부만 그리면 안 보이는 줄이
 * 「꺼짐」처럼 읽히고, 그 상태로 저장하면 보이지 않던 줄이 그대로 남는다.
 * 반쪽짜리 표를 그리느니 「지금은 볼 수 없다」가 정직하다.
 */
export function parseSettingsPayload(
  raw: unknown
): { roles: PortalSettingsRole[]; kinds: PortalSettingsKind[] } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as { roles?: unknown; kinds?: unknown };
  if (!Array.isArray(body.roles) || !Array.isArray(body.kinds)) return null;

  const roles: PortalSettingsRole[] = [];
  for (const entry of body.roles) {
    if (typeof entry !== "object" || entry === null) return null;
    const row = entry as Record<string, unknown>;
    const code = text(row.code);
    const label = text(row.label);
    const editable = bool(row.editable);
    if (code === null || code === "" || label === null || editable === null) return null;
    roles.push({ code, label, editable });
  }

  const kinds: PortalSettingsKind[] = [];
  for (const entry of body.kinds) {
    if (typeof entry !== "object" || entry === null) return null;
    const row = entry as Record<string, unknown>;
    const kind = text(row.kind);
    const label = text(row.label);
    const enabled = bool(row.enabled);
    const defaultEnabled = bool(row.defaultEnabled);
    if (kind === null || kind === "" || label === null) return null;
    if (enabled === null || defaultEnabled === null) return null;
    if (typeof row.roles !== "object" || row.roles === null || Array.isArray(row.roles)) {
      return null;
    }

    const cells: Record<string, PortalSettingsRoleCell> = {};
    for (const [code, cell] of Object.entries(row.roles as Record<string, unknown>)) {
      if (typeof cell !== "object" || cell === null) return null;
      const receives = bool((cell as Record<string, unknown>).receives);
      const defaultReceives = bool((cell as Record<string, unknown>).defaultReceives);
      if (receives === null || defaultReceives === null) return null;
      cells[code] = { receives, defaultReceives };
    }

    kinds.push({
      kind,
      label,
      // 설명은 없어도 표가 그려진다 — 이것만은 없다고 버리지 않는다.
      description: text(row.description) ?? "",
      enabled,
      defaultEnabled,
      roles: cells,
    });
  }

  return { roles, kinds };
}

/**
 * 포털 화면이 보낸 저장 요청의 모양 확인.
 *
 * 🔴 **값이 옳은지는 보지 않는다.** 모르는 종류·역할을 걸러 내는 것은 그
 * 시스템의 몫이고(A/S 의 saveNotificationSettings 가 트랜잭션 안에서 다시
 * 판정한다), 포털이 그 판정을 흉내 내면 곧 A/S 의 어휘가 포털에 스며든다.
 * 여기서는 **넘길 수 있는 모양인가**만 본다.
 */
export function parseSettingsChanges(
  body: unknown
): { ok: true; changes: PortalSettingsChange[] } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "요청 본문을 읽을 수 없습니다." };
  }
  const changes = (body as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) {
    return { ok: false, message: "알림 설정 값을 확인할 수 없습니다." };
  }

  const parsed: PortalSettingsChange[] = [];
  for (const entry of changes) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "알림 설정 값을 확인할 수 없습니다." };
    }
    const row = entry as Record<string, unknown>;
    const kind = text(row.kind);
    const enabled = bool(row.enabled);
    if (kind === null || kind === "") {
      return { ok: false, message: "알림 종류를 확인할 수 없습니다." };
    }
    if (enabled === null) {
      return { ok: false, message: "알림 사용 여부를 확인할 수 없습니다." };
    }
    if (typeof row.roles !== "object" || row.roles === null || Array.isArray(row.roles)) {
      return { ok: false, message: "알림 대상 값을 확인할 수 없습니다." };
    }
    const roles: Record<string, boolean> = {};
    for (const [code, value] of Object.entries(row.roles as Record<string, unknown>)) {
      if (typeof value !== "boolean") {
        return { ok: false, message: "알림 대상 값을 확인할 수 없습니다." };
      }
      roles[code] = value;
    }
    parsed.push({ kind, enabled, roles });
  }

  return { ok: true, changes: parsed };
}

/** 받은 답에서 사람에게 보여 줄 한 줄을 꺼낸다. 없으면 우리가 적는다. */
export function messageFrom(raw: unknown, fallback: string): string {
  if (typeof raw === "object" && raw !== null) {
    const message = (raw as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return fallback;
}

/** 물어볼 곳이 하나도 없을 때. 🔴 오류가 아니다. 함수인 까닭은 emptyFeed 와 같다. */
export function emptySettings(): PortalSettingsOverview {
  return { systems: [], degraded: false };
}

/** 못 물어본 시스템 한 줄. */
export function unavailableSystem(
  source: NotificationSource,
  message: string
): PortalSettingsSystem {
  return {
    clientId: source.clientId,
    name: source.name,
    status: "unavailable",
    message,
  };
}
