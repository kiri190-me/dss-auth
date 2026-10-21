import type { PortalSettingsKind } from "./settings";
import { KIND_MARKER_FIELD } from "./settings-form";

/**
 * ============================================================================
 * 알림 종류의 **분류** — 정보 확인용인가, 승인용인가
 * ============================================================================
 * 🔴 **이 값 하나만 포털이 직접 갖는다.** 사용·역할은 각 시스템의 것이고 포털은
 * 물어서 그릴 뿐인데(settings.ts 머리말), 분류는 포털 DB 에 쌓인다
 * (db/schema/notification-kind-purposes.ts 에 그 까닭이 적혀 있다 — 다섯 시스템
 * 가운데 넷은 설정 저장을 403 으로 거절한다).
 *
 * 그래서 이 파일은 settings-form.ts 와 **같은 결로, 나란히** 있다. 저쪽이 「저
 * 시스템에 보낼 것」을 고르고, 이쪽이 「포털에 적을 것」을 고른다. 둘 다 순수
 * 함수라 네트워크도 DB 도 모른다.
 *
 * ── 🔴 모르면 남긴다 — 기본값이 `ACTION` 인 까닭 ───────────────────────────
 * 행이 없거나 모르는 글자면 **승인용**으로 본다. 두 방향의 실수 값이 다르기
 * 때문이다:
 *  · 승인용을 정보 확인용으로 잘못 보면 — 사람이 눌러 확인한 순간 그 알림이
 *    영영 사라진다. 결재나 부품 요청을 **놓치고, 놓쳤다는 사실을 아무도 모른다.**
 *  · 정보 확인용을 승인용으로 잘못 보면 — 지워야 할 줄이 종에 남는다. 눈에
 *    거슬릴 뿐 일을 놓치지는 않는다.
 * 한쪽은 조용한 사고이고 한쪽은 시끄러운 불편이다. 모를 때는 시끄러운 쪽으로 간다.
 *
 * ── 🔴 이 조각은 값을 정해 저장하는 데까지다 ───────────────────────────────
 * 저장된 값을 읽어 **종이 실제로 달라지는 것은 다음 조각**이다. 지금은 아무도
 * 이 값을 보지 않는다 — 화면 설명문이 동작을 단언하지 않는 것도 그래서다.
 * ============================================================================
 */

/** 분류 두 가지. 🔴 화면의 선택지 차례도 이 차례다. */
export const NOTIFICATION_PURPOSES = ["INFO", "ACTION"] as const;

export type NotificationPurpose = (typeof NOTIFICATION_PURPOSES)[number];

/** 🔴 모를 때의 값. 위 「모르면 남긴다」 문단이 근거다. */
export const DEFAULT_NOTIFICATION_PURPOSE: NotificationPurpose = "ACTION";

/**
 * 화면에 그릴 글자.
 *
 * 🔴 **쓰는 분이 직접 고른 낱말이다**(2026-10-21). 「알림용/결재용」처럼 더 짧은
 * 말이 떠올라도 바꾸지 마라 — 여기서 바꾸면 화면의 고르개와 설명문이 함께
 * 달라지고, 사람이 고른 말이 아니게 된다.
 */
export const NOTIFICATION_PURPOSE_LABELS: Readonly<Record<NotificationPurpose, string>> = {
  INFO: "정보 확인용",
  ACTION: "승인용",
};

/** 종류 하나의 분류 고르개. settings-form.ts 의 enabledFieldName 과 같은 모양이다. */
export function purposeFieldName(kind: string): string {
  return `purpose:${kind}`;
}

/**
 * 아는 글자인가.
 *
 * 🔵 `includes` 에 넣기 위해 한 번 넓히는 까닭: `readonly ["INFO", "ACTION"]` 의
 * `includes` 는 그 두 글자만 받으므로, 모르는 글자를 물어보는 이 함수에 쓸 수 없다.
 */
export function isNotificationPurpose(value: unknown): value is NotificationPurpose {
  return (NOTIFICATION_PURPOSES as readonly string[]).includes(value as string);
}

/**
 * 저장된 칸 값 하나를 분류로 읽는다. 🔴 모르는 글자는 기본값으로 떨어진다.
 *
 * DB 에 CHECK 를 걸지 않은 근거가 이 함수다(스키마 파일의 그 주석). 제약 대신
 * **읽기가 안전을 지킨다** — 손으로 넣은 값이든 다음 판에서 늘렸다 되돌린 값이든
 * 여기서 승인용이 되므로 알림이 사라지는 사고로 이어지지 않는다.
 */
export function toNotificationPurpose(value: unknown): NotificationPurpose {
  return isNotificationPurpose(value) ? value : DEFAULT_NOTIFICATION_PURPOSE;
}

/**
 * 그 종류의 지금 분류. **행이 없으면 기본값**이다.
 *
 * 🔴 기본값을 채우는 자리가 여기 하나다. 읽기 조회(queries/notification-kind-purposes.ts)
 * 는 **있는 행만** 돌려준다 — 그쪽은 그 시스템의 종류 목록을 모르기 때문이다(목록은
 * 저쪽이 보내 준다). 없는 열쇠에 기본값을 채우려면 조회가 알 수 없는 것을 알아야 한다.
 */
export function purposeOf(
  stored: ReadonlyMap<string, NotificationPurpose>,
  kind: string
): NotificationPurpose {
  return stored.get(kind) ?? DEFAULT_NOTIFICATION_PURPOSE;
}

/** 저장할 줄 하나. */
export type NotificationKindPurposeChange = {
  kind: string;
  purpose: NotificationPurpose;
};

/**
 * 폼에서 읽는 데 필요한 것만. settings-form.ts 의 SubmittedForm 과 같은 뜻이고,
 * 쓰는 함수가 달라 고르는 것도 다르다 — 이쪽은 고르개 한 칸이라 `get` 이다.
 */
export type SubmittedPurposeForm = Pick<FormData, "get" | "getAll">;

/**
 * 「사람이 보낸 표」와 「지금 저장된 값」을 견줘 **달라진 분류만** 만든다.
 * settings-form.ts 의 diffSubmittedSettings 와 같은 결이다.
 *
 * 세 가지를 건드리지 않는다:
 *
 * 🔴 **화면에 없던 종류.** 줄마다 실려 오는 표시(KIND_MARKER_FIELD)가 없는
 * 종류는 사람이 뜻을 정한 적이 없다 — 화면을 연 뒤 저쪽이 새로 만든 줄이다.
 * 🔵 표시를 저쪽 파일 것과 **같은 것으로 쓴다.** 뜻이 똑같은 사실(「이 줄이
 * 화면에 있었다」)이라, 분류용 표시를 따로 두면 둘이 어긋나는 상태가 생긴다.
 *
 * 🔴 **칸이 아예 안 실린 종류.** 사람이 보낸 적 없는 값이다. 기본값으로 채워
 * 저장하면 **누가 정한 적 없는 줄이 DB 에 생긴다.**
 *
 * 🔴 **모르는 글자가 실려 온 종류.** 저장이 아니라 **무시**다. 손으로 요청을
 * 지어 보낸 것이거나 화면이 깨진 것인데, 어느 쪽이든 사람의 뜻이 아니다.
 * (기본값으로 떨어뜨리지도 않는다 — 그러면 멀쩡히 `INFO` 였던 줄이 조용히
 * `ACTION` 으로 덮인다.)
 */
export function diffSubmittedPurposes(params: {
  form: SubmittedPurposeForm;
  /** 그 시스템이 지금 내주는 종류. 여기 없는 종류는 쳐다보지 않는다. */
  kinds: readonly Pick<PortalSettingsKind, "kind">[];
  /** 포털에 저장된 값. 없는 열쇠는 기본값으로 본다(purposeOf). */
  stored: ReadonlyMap<string, NotificationPurpose>;
}): NotificationKindPurposeChange[] {
  const onScreen = new Set(
    params.form
      .getAll(KIND_MARKER_FIELD)
      .filter((value): value is string => typeof value === "string")
  );

  const changes: NotificationKindPurposeChange[] = [];

  for (const row of params.kinds) {
    if (!onScreen.has(row.kind)) continue;

    const submitted = params.form.get(purposeFieldName(row.kind));
    // 안 실렸거나(null) 모르는 글자다. 둘 다 무시한다 — 위 머리말 그대로.
    if (!isNotificationPurpose(submitted)) continue;

    if (submitted === purposeOf(params.stored, row.kind)) continue;
    changes.push({ kind: row.kind, purpose: submitted });
  }

  return changes;
}
