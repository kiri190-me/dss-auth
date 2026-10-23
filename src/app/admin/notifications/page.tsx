import type { Metadata } from "next";
import {
  APPROVAL_MAIL_KINDS,
  approvalKindFieldName,
  isApprovalMailKindEnabled,
} from "@/lib/approvals/kinds";
import { APPROVAL_INBOX_URL_ENV, readApprovalInboxUrl } from "@/lib/approvals/inbox-url";
import { requirePortalAdmin } from "@/lib/auth/portal-admin";
import { listEnabledApprovalMailKinds } from "@/lib/db/queries/approval-mail-kinds";
import { listKindPurposes } from "@/lib/db/queries/notification-kind-purposes";
import {
  DEFAULT_NOTIFICATION_PURPOSE,
  NOTIFICATION_PURPOSES,
  NOTIFICATION_PURPOSE_LABELS,
  purposeFieldName,
  purposeOf,
  type NotificationPurpose,
} from "@/lib/notifications/purposes";
import { getNotificationSettings } from "@/lib/notifications/service";
import type {
  PortalSettingsKind,
  PortalSettingsRole,
  PortalSettingsSystem,
} from "@/lib/notifications/settings";
import {
  KIND_MARKER_FIELD,
  ROLES_LOCKED_FIELD,
  type ShownKindState,
  enabledFieldName,
  receivesFieldName,
  shownKindState,
} from "@/lib/notifications/settings-form";
import {
  saveApprovalMailKindSettings,
  sendApprovalTestMail,
} from "@/lib/server/actions/approval-mail-settings";
import { saveSystemNotificationSettings } from "@/lib/server/actions/notification-settings";

export const metadata: Metadata = { title: "알림 설정 | DSS 통합 로그인" };

/**
 * ============================================================================
 * 알림 설정 — 여러 시스템의 알림 정책을 한 화면에서
 * ============================================================================
 * 「사용자 관리를 밖으로 빼려 한 주된 이유가 알림이었다」(2026-09-21 사용자
 * 결정). 그래서 이 화면이 통합 관리의 한복판이다.
 *
 * 🔴 **값의 주인은 각 시스템이다.** 이 화면은 물어서 그리고, 저장하면 되돌려
 * 보낼 뿐이다. 포털 DB 에 알림 설정이 한 줄도 없다(설계서 D-5).
 *
 * 🔴 **역할 이름도 알림 종류도 여기 적혀 있지 않다.** 표의 머리도 줄 이름도
 * 그 시스템이 글자로 함께 보내 준 것을 그대로 그린다(설계서 F-4). 그래야 A/S 가
 * 역할을 하나 늘릴 때 포털이 가만히 있어도 된다.
 *
 * ── 왜 자바스크립트가 없는가 ──────────────────────────────────────────────
 * 이 저장소의 화면은 하나도 빠짐없이 서버에서만 그려진다("use client" 가 한 줄도
 * 없다). A/S 쪽 같은 화면은 브라우저에서 도는 표지만, 그것을 옮겨 오면 포털에
 * 없던 틀이 하나 생긴다. 평범한 폼으로도 할 일은 다 된다 — 체크하고, 저장을
 * 누르고, 「되돌리기」는 브라우저의 폼 초기화가 그대로 해 준다. 무엇이 바뀌었나를
 * 세는 일만 서버로 옮겼다(notifications/settings-form.ts).
 *
 * ── 「전부 기본값으로」도 자바스크립트 없이 ───────────────────────────────
 * A/S 화면에 있던 단추다(2026-09-22, 그 탭을 걷어내기 전에 옮겼다). 브라우저
 * 쪽에서 값을 갈아 끼우는 대신 **주소에 표시를 하나 달아 서버가 같은 표를 기본값
 * 으로 다시 그린다**(`?defaults=<clientId>`). 그래서 이것은 단추가 아니라 링크다.
 *
 * 🔴 A/S 와 뜻이 같다 — **화면만 기본값으로 돌리고 저장은 따로다.** 눌러도 아무
 * 것도 저장되지 않고, 표가 기본값으로 다시 그려질 뿐이다. 그 표를 저장하면 저장
 * 액션이 「지금 값」과 견줘 달라진 줄만 보낸다(server/actions 의 그 계산 그대로).
 * 눌렀다가 마음이 바뀌면 저장하지 말고 돌아오면 된다.
 *
 * 다른 길도 있었다. (A) 「기본값으로 저장까지 하는 액션」은 한 번에 끝나지만
 * **누르는 순간 저장돼** A/S 와 뜻이 달라진다(되돌릴 기회가 없다). (B) 이 표만
 * "use client" 로 바꾸면 A/S 와 똑같아지지만 이 저장소에 없던 틀이 하나 생기고,
 * 자바스크립트 없이 도는 성질을 이 화면만 잃는다. 링크 한 줄이 둘 다 피한다.
 *
 * ── 알림이 없는 시스템은 아예 나오지 않는다 ───────────────────────────────
 * 계측기·개선요청·PO 에는 알림 자체가 없다. 그 시스템들을 「알림 없음」 줄로
 * 그리려면 포털이 「저기엔 알림이 없다」고 단언해야 하는데, 그 판단의 근거는
 * 지금 상수 하나뿐이고(notifications/sources.ts) 곧 DB 칸으로 옮겨 갈 것이다.
 * 확실하지 않은 것을 화면에 단언으로 적지 않는다 — 대신 맨 아래에 「알림 통로를
 * 연 시스템만 나온다」고 한 줄 적어 둔다. 빈 화면을 보고 고장으로 오해하는 것만
 * 막으면 충분하다.
 *
 * ── 🔴 「분류」 칸 하나만은 포털이 갖는다 (2026-10-21) ────────────────────────
 * 위 「값의 주인은 각 시스템이다」에 예외가 하나 생겼다. 알림 통로를 연 다섯
 * 가운데 **설정을 실제로 바꿀 수 있는 곳은 A/S 하나뿐**이고, 나머지 넷은 모든
 * 칸이 `editable: false` 이며 저장을 403 으로 거절한다. 분류까지 저쪽에 맡기면
 * 그 넷은 영영 고칠 수 없다 — 그래서 이 값만 포털 DB 에 둔다
 * (db/schema/notification-kind-purposes.ts 에 까닭이 길게 적혀 있다).
 *
 * 🔴 그 결과가 화면에서 하나로 드러난다: **분류 고르개는 어떤 시스템에서도,
 * 사용을 끈 줄에서도 잠기지 않는다.** 역할 칸을 잠그는 두 조건(`!role.editable`
 * ·`shown.rolesLocked`)을 따라 하지 마라 — 그 둘은 「저쪽이 못 바꾸게 했다」와
 * 「저쪽에 보내 봐야 소용없다」인데, 이 값은 저쪽으로 가지 않는다.
 * ============================================================================
 */

const BTN =
  "rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40";
const BTN_PLAIN =
  "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900";
const NOTE = "text-xs text-zinc-500";

/** 이 화면의 주소. 저장 액션도 같은 곳으로 돌아온다. */
const PATH = "/admin/notifications";

/**
 * 표를 못 그리는 구역(forbidden·unavailable)에 넘길 빈 분류.
 *
 * 🔵 상수인 까닭: 그릴 때마다 `new Map()` 을 만들면 그 구역이 다시 그려질 때마다
 * 값이 달라진 것처럼 보인다. 어차피 비어 있고 아무도 고치지 않는다.
 */
const NO_PURPOSES: ReadonlyMap<string, NotificationPurpose> = new Map();

/** 시스템 구역의 닻. 링크로 돌아왔을 때 그 표가 바로 보이게 한다. */
function blockId(clientId: string): string {
  return `system-${clientId}`;
}

function blockHref(clientId: string): string {
  return `${PATH}#${encodeURIComponent(blockId(clientId))}`;
}

/**
 * 「전부 기본값으로」의 주소. 🔴 **누른 시스템 하나만** 기본값으로 그린다 —
 * 화면에 시스템이 여럿이라, 하나를 눌렀는데 옆 표까지 달라지면 무엇을 저장하는
 * 것인지 알 수 없게 된다.
 */
function defaultsHref(clientId: string): string {
  const id = encodeURIComponent(blockId(clientId));
  return `${PATH}?defaults=${encodeURIComponent(clientId)}#${id}`;
}

/**
 * 기본값에서 벗어난 칸 표시. A/S 화면과 같은 장치이고, 뜻도 같다 — ▲ 는 기본보다
 * 넓게 준 칸, ▼ 는 기본에서 뺀 칸이다.
 */
function DefaultMark({ on, isDefault }: { on: boolean; isDefault: boolean }) {
  if (isDefault) return null;
  return (
    <span
      title={on ? "기본값에는 없던 대상입니다" : "기본값에서 뺀 대상입니다"}
      className="mt-0.5 block text-[10px] text-amber-600 dark:text-amber-400"
    >
      {on ? "▲" : "▼"}
    </span>
  );
}

/** 종류 × 역할 한 칸. */
function RoleCell({
  row,
  role,
  shown,
}: {
  row: PortalSettingsKind;
  role: PortalSettingsRole;
  shown: ShownKindState;
}) {
  // 그 시스템이 이 칸을 보내지 않았다. 체크박스를 그리면 「꺼짐」으로 읽히고,
  // 저장하면 없던 값을 만들어 내게 된다. 저장 쪽(settings-form.ts)과 **같은
  // 조건**으로 본다 — 화면에 없는 칸이 저장에 실리면 안 된다.
  const cell = Object.hasOwn(row.roles, role.code) ? row.roles[role.code] : undefined;

  if (!cell) {
    return (
      <td className="px-2 py-2 text-center text-xs text-zinc-400" title="이 종류에는 없는 역할입니다">
        —
      </td>
    );
  }

  // 화면에 그릴 값. 「전부 기본값으로」를 누른 뒤에는 기본값이다.
  const checked = shown.roles[role.code];

  return (
    <td className="px-2 py-2 text-center">
      <input
        type="checkbox"
        name={receivesFieldName(row.kind, role.code)}
        defaultChecked={checked}
        // 🔴 잠긴 칸은 보내지 않는다. 브라우저가 disabled 칸을 빼고 보내는 것이
        // 곧 「그대로 두라」가 된다(settings-form.ts 의 그 주석).
        //
        // 🔴 잠그는 까닭이 둘이다. `!role.editable` 은 **그 역할이라서**(저쪽이
        // 끌 수 없다고 보낸 줄), `shown.rolesLocked` 는 **사용을 껐기 때문**이다.
        // 끈 종류의 역할을 고르면 무언가 달라졌다고 믿게 되지만 아무에게도 가지
        // 않는다 — A/S 화면이 같은 자리를 같은 이유로 잠가 두었다.
        disabled={!role.editable || shown.rolesLocked}
        title={
          shown.rolesLocked && role.editable
            ? "사용이 꺼진 종류입니다. 사용을 켜고 저장하면 이 칸을 고칠 수 있습니다."
            : undefined
        }
        aria-label={`${row.label} — ${role.label}`}
        className="h-4 w-4 disabled:cursor-not-allowed disabled:opacity-30"
      />
      {role.editable ? (
        <DefaultMark on={checked} isDefault={checked === cell.defaultReceives} />
      ) : (
        <span title="이 역할이 받는 알림은 끌 수 없습니다" className="mt-0.5 block text-[10px] text-zinc-400">
          고정
        </span>
      )}
    </td>
  );
}

/**
 * 종류 하나의 「분류」 칸.
 *
 * 🔴 **잠기는 조건이 없다.** 옆의 RoleCell 과 다른 점이고, 이 칸을 더한 이득이
 * 바로 그것이다(이 파일 머리말) — 저쪽이 설정을 잠가 둔 시스템에서도, 사용을 끈
 * 줄에서도 분류는 고칠 수 있다. 끈 종류가 역할 설정을 그대로 안고 기다리는 것과
 * 같은 성질이다(표 아래 설명문).
 */
function PurposeCell({
  row,
  purpose,
}: {
  row: PortalSettingsKind;
  purpose: NotificationPurpose;
}) {
  return (
    <td className="px-2 py-2 text-center">
      {/*
        🔴 <select> 다. 이 화면은 자바스크립트 없이 도는 평범한 폼이라(머리말)
        고르개도 HTML 만으로 되는 것을 쓴다. `defaultValue` 로 지금 값을 그리고,
        「되돌리기」는 브라우저의 폼 초기화가 그대로 해 준다.
      */}
      <select
        name={purposeFieldName(row.kind)}
        defaultValue={purpose}
        aria-label={`${row.label} 분류`}
        className="rounded-md border border-zinc-300 bg-white px-1.5 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
      >
        {NOTIFICATION_PURPOSES.map((value) => (
          <option key={value} value={value}>
            {NOTIFICATION_PURPOSE_LABELS[value]}
          </option>
        ))}
      </select>
    </td>
  );
}

/** 설정을 읽어 온 시스템 하나의 표. */
function SystemTable({
  system,
  purposes,
  showDefaults,
}: {
  system: Extract<PortalSettingsSystem, { status: "ok" }>;
  /** 🔴 포털 DB 에 저장된 분류. 행이 없는 종류는 여기에도 없다(purposeOf 가 채운다). */
  purposes: ReadonlyMap<string, NotificationPurpose>;
  showDefaults: boolean;
}) {
  if (system.kinds.length === 0) {
    return <p className={`mt-3 ${NOTE}`}>이 시스템이 내주는 알림 종류가 없습니다.</p>;
  }

  const rows = system.kinds.map((row) => {
    const stored = purposeOf(purposes, row.kind);
    /*
      🔴 「전부 기본값으로」는 분류도 따라간다 — 분류의 기본값은 ACTION(승인용)
      이다. 그 링크의 글자가 「전부」이므로 한 칸만 남겨 두면 거짓말이 되고,
      기본값이 안전한 쪽이라 따라가도 알림을 놓치는 방향으로는 가지 않는다
      (purposes.ts 의 「모르면 남긴다」).
    */
    const purpose = showDefaults ? DEFAULT_NOTIFICATION_PURPOSE : stored;
    return {
      row,
      purpose,
      shown: shownKindState({ row, roles: system.roles, showDefaults }),
      // 🔴 분류도 「저장을 누르면 바뀌는 줄」에 센다. 안 세면 분류만 달라진 줄이
      // 색 없이 남고, 아래 안내문의 숫자가 실제로 바뀔 줄보다 적어진다.
      purposeDiffers: purpose !== stored,
    };
  });
  const differentCount = rows.filter(
    (entry) => entry.shown.differsFromStored || entry.purposeDiffers
  ).length;

  return (
    /*
      🔴 key 가 붙은 까닭: 「전부 기본값으로」는 같은 화면을 **다른 초기값**으로
      다시 그린다. 그런데 defaultChecked 는 말 그대로 처음 한 번뿐이라, 같은
      <input> 이 그 자리에 그대로 남으면 화면의 체크는 옛 값인 채로 남는다 —
      오류도 안 나고 표만 거짓말을 한다. 아래 링크를 <a> 로 둔 것(통째로 다시
      불러온다)이 1차 방어이고, 누가 <Link> 로 바꿔도 조용히 깨지지 않도록 이
      key 로 한 겹 더 둔다.
    */
    <form
      key={showDefaults ? "defaults" : "stored"}
      action={saveSystemNotificationSettings}
      className="mt-3"
    >
      <input type="hidden" name="clientId" value={system.clientId} />

      <div className="overflow-x-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <table className="w-full border-collapse text-sm">
          {/*
            🔴 머리 칸은 줄바꿈하지 않는다. 역할이 다섯이라 칸이 좁아 「A/S 엔지니어」
            같은 이름이 두 줄로 접혔다. white-space 는 물려받는 성질이라 thead 에 한 번
            적으면 **저쪽이 역할을 늘려 새 칸이 생겨도** 따라온다 — 역할마다 적으면
            지금 다섯에만 통한다.

            이름을 잘라 내지(truncate) 않고 nowrap 만 쓴 까닭: 「A/S 엔지…」는 읽을 수
            없고, 줄이려면 포털이 역할 이름을 고쳐 쓰는 셈이 된다. 저쪽이 보낸 글자
            그대로여야 한다(이 파일 머리말). 대신 칸이 넓어져 표가 화면을 넘으면 바깥
            상자의 overflow-x-auto 가 가로 스크롤을 준다 — 폰에서도 이름이 온전하다.
          */}
          <thead className="whitespace-nowrap text-xs text-zinc-500">
            <tr>
              <th scope="col" className="py-1 pr-3 text-left font-medium">
                알림 종류
              </th>
              <th scope="col" className="px-2 py-1 text-center font-medium">
                사용
              </th>
              {/*
                🔴 「사용」 다음, 역할 앞이다. 사용과 분류는 **그 종류 자체의
                성질**이고 역할은 그 뒤에 오는 것이라서다. 역할 칸들 사이에 끼면
                역할 하나로 읽힌다.
              */}
              <th scope="col" className="px-2 py-1 text-center font-medium">
                분류
              </th>
              {/* 🔴 역할 머리는 받은 글자 그대로다. 포털에 번역표가 없다. */}
              {system.roles.map((role) => (
                <th key={role.code} scope="col" className="px-2 py-1 text-center font-medium">
                  {role.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, shown, purpose, purposeDiffers }) => (
              <tr
                key={row.kind}
                className={`border-t border-zinc-200 align-top dark:border-zinc-800 ${
                  // 저장을 누르면 바뀌는 줄. 지금은 「전부 기본값으로」를 누른
                  // 뒤에만 생긴다 — 평소에는 화면 값이 곧 저장된 값이다.
                  shown.differsFromStored || purposeDiffers
                    ? "bg-blue-50/60 dark:bg-blue-950/20"
                    : ""
                }`}
              >
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {/*
                    이 줄이 화면에 있었다는 표시. 없으면 저장 쪽이 그 종류를
                    건드리지 않는다 — 화면을 연 뒤 저쪽이 늘린 종류를 「전부 끄라」로
                    읽지 않기 위한 것이다.
                  */}
                  <input type="hidden" name={KIND_MARKER_FIELD} value={row.kind} />
                  {/*
                    🔴 이 줄의 역할 칸이 잠긴 채 그려졌다는 표시. 잠긴 칸은 폼에
                    실리지 않으므로, 이것이 없으면 저장 쪽이 「역할을 전부 껐다」로
                    읽는다(settings-form.ts 머리말).
                  */}
                  {shown.rolesLocked ? (
                    <input type="hidden" name={ROLES_LOCKED_FIELD} value={row.kind} />
                  ) : null}
                  {/*
                    종류 이름도 접히지 않게 둔다. 머리 칸이 제 너비를 가져가면 이 칸이
                    좁아지는데, 그때 이름까지 여러 줄로 흩어지면 표를 훑을 수 없다.
                  */}
                  <span className="block whitespace-nowrap font-medium text-zinc-900 dark:text-zinc-50">
                    {row.label}
                  </span>
                  {/*
                    설명은 접어 둔다 — 지우지 않는다.

                    종류마다 붙은 설명이 서너 줄씩이라(A/S 의 NOTIFICATION_KIND_META),
                    여덟 줄이 모이면 표가 글 벽이 된다. 그렇다고 한 줄로 잘라 title 에
                    숨기면 폰에서는 title 이 뜨지 않아 **볼 길이 사라진다** — 무슨
                    알림인지 모르면 켜고 끌 수가 없다.

                    <details> 는 자바스크립트가 아니라 HTML 이라 이 저장소의 규칙
                    (서버에서만 그린다)을 그대로 지킨다. 기본은 접힘이라 화면이 성기고,
                    펴면 **저쪽이 보낸 글자가 한 자도 빠짐없이** 나온다. 키보드로도
                    열리고, 접힌 채로도 검색(Ctrl+F)에 걸린다.
                  */}
                  {row.description ? (
                    <details className="mt-0.5 max-w-md">
                      <summary className="cursor-pointer text-xs font-normal text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                        설명
                      </summary>
                      <p className="mt-1 text-xs font-normal leading-relaxed text-zinc-500">
                        {row.description}
                      </p>
                    </details>
                  ) : null}
                </th>

                <td className="px-2 py-2 text-center">
                  <input
                    type="checkbox"
                    name={enabledFieldName(row.kind)}
                    defaultChecked={shown.enabled}
                    aria-label={`${row.label} 사용`}
                    className="h-4 w-4"
                  />
                  <DefaultMark
                    on={shown.enabled}
                    isDefault={shown.enabled === row.defaultEnabled}
                  />
                  {shown.enabled ? null : (
                    <span className="mt-0.5 block text-[10px] text-amber-700 dark:text-amber-400">
                      아무에게도 안 감
                    </span>
                  )}
                </td>

                <PurposeCell row={row} purpose={purpose} />

                {system.roles.map((role) => (
                  <RoleCell key={role.code} row={row} role={role} shown={shown} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className={`mt-2 ${NOTE}`}>
        <span className="text-amber-600 dark:text-amber-400">▲</span> 기본값보다 넓게 준 칸,{" "}
        <span className="text-amber-600 dark:text-amber-400">▼</span> 기본값에서 뺀 칸입니다.
        「사용」을 끄는 것과 역할을 전부 지우는 것은 다릅니다 — 끈 종류는 역할 설정을
        그대로 안고 기다리다가 다시 켜는 순간 돌아옵니다. 사용을 끈 종류는 역할 칸이
        잠깁니다.
      </p>

      {/*
        🔴 「지금 그렇게 동작한다」고 적지 않는다. 저장된 분류를 읽어 종이 달라지는
        것은 **다음 조각**이고, 화면이 거짓말을 하면 안 된다. 그래서 뜻만 적고
        동작은 앞으로의 일로 쓴다.
      */}
      <p className={`mt-2 ${NOTE}`}>
        <strong className="font-medium">분류</strong>는 그 알림의 성격을 적어 두는
        칸입니다. 「정보 확인용」은 사람이 보고 확인하면 끝나는 알림, 「승인용」은 그
        일이 실제로 처리되어야 끝나는 알림이라는 뜻입니다 — 앞으로 종이 알림을 언제까지
        들고 있을지를 이 값으로 정하게 됩니다. 이 값만은{" "}
        <strong className="font-medium">포털이 가지고 있어</strong>, 다른 칸이 잠긴
        시스템에서도 고칠 수 있습니다.
      </p>

      {showDefaults ? (
        <p
          role="status"
          className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
        >
          지금 이 표는 <strong className="font-medium">코드가 정한 기본값</strong>입니다.
          아직 아무것도 저장되지 않았습니다 —{" "}
          {differentCount === 0
            ? "지금 저장된 값이 이미 기본값과 같습니다."
            : `저장을 누르면 색이 들어온 ${differentCount}개 종류가 바뀝니다.`}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="submit"
          className={`${BTN} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900`}
        >
          저장
        </button>

        {showDefaults ? (
          // 기본값 표를 보고 있을 때는 폼 초기화가 「되돌리기」가 되지 못한다 —
          // 이 화면의 처음 상태가 곧 기본값이라 눌러 봐야 제자리다. 그래서 저장된
          // 값을 다시 받아 오는 링크로 바꾼다.
          <a
            href={blockHref(system.clientId)}
            className={`${BTN} ${BTN_PLAIN} inline-block`}
            title="저장된 값으로 돌아갑니다"
          >
            되돌리기
          </a>
        ) : (
          /* 브라우저의 폼 초기화 — 저장하지 않은 편집을 불러온 값으로 되돌린다. */
          <button type="reset" className={`${BTN} ${BTN_PLAIN}`}>
            되돌리기
          </button>
        )}

        {showDefaults ? null : (
          /*
            🔴 단추가 아니라 링크다. 이 화면을 기본값으로 **다시 그려 달라**는
            요청이고 저장이 아니다(이 파일 머리말). 🔴 <Link> 로 바꾸지 마라 —
            같은 <input> 이 남아 체크가 옛 값 그대로인 채 표만 거짓말을 한다.
          */
          <a
            href={defaultsHref(system.clientId)}
            className={`${BTN} ${BTN_PLAIN} inline-block`}
            title="표를 기본값으로 다시 그립니다. 저장하지 않은 편집은 사라지고, 저장을 눌러야 실제로 바뀝니다."
          >
            전부 기본값으로
          </a>
        )}
      </div>
    </form>
  );
}

/** 한 시스템 구역. 🔴 셋 가운데 둘은 고장이 아니라 답이다. */
function SystemBlock({
  system,
  purposes,
  showDefaults,
}: {
  system: PortalSettingsSystem;
  purposes: ReadonlyMap<string, NotificationPurpose>;
  showDefaults: boolean;
}) {
  return (
    <section id={blockId(system.clientId)} className="mt-8 scroll-mt-4">
      <h2 className="text-sm font-semibold">
        {system.name}
        <span className="ml-2 text-xs font-normal text-zinc-500">{system.clientId}</span>
      </h2>

      {system.status === "ok" ? (
        <SystemTable system={system} purposes={purposes} showDefaults={showDefaults} />
      ) : null}

      {system.status === "forbidden" ? (
        <div className="mt-3 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <p className="text-sm font-medium">권한 없음</p>
          <p className={`mt-1 ${NOTE}`}>{system.message}</p>
          <p className={`mt-1 ${NOTE}`}>
            포털 관리자라는 것이 그 시스템의 관리자라는 뜻은 아닙니다. 그 시스템에서
            관리자 이상의 역할을 받아야 이 표가 보입니다.
          </p>
        </div>
      ) : null}

      {system.status === "unavailable" ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950"
        >
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            지금 물어볼 수 없음
          </p>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{system.message}</p>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            그 시스템이 꺼져 있거나 답이 늦습니다. 다른 시스템의 설정은 그대로 쓸 수
            있습니다.
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * ============================================================================
 * 결재 알림 메일 구역 — 🔴 이 화면에서 **유일하게 메일을 켜는 자리**
 * ============================================================================
 * 위의 시스템 표들과 뜻이 다르다. 저것들은 「그 시스템의 종 설정」을 물어서
 * 그리는 것이고, 이것은 **포털이 보내는 메일**의 설정이다. 그래서 값도 포털
 * DB 에 있고(`approval_mail_kinds`), 시스템이 죽어 있어도 이 구역은 그대로 뜬다.
 *
 * 🔴 **기본값은 전부 끔**(2026-10-23 결정). 체크가 하나도 없는 것이 처음 상태이고,
 * 그 상태에서는 메일이 한 통도 나가지 않는다.
 *
 * 🔵 「전부 기본값으로」 링크를 두지 않았다. 위 표들의 그 링크는 **코드가 정한
 * 기본값**이 따로 있어서 뜻이 있는데, 여기 기본값은 「전부 끔」 하나라 체크를
 * 전부 지우는 것과 같다 — 단추 하나 늘리는 값이 없다.
 * ============================================================================
 */
function ApprovalMailBlock({
  enabledKeys,
  inboxUrl,
}: {
  /** 🔴 `null` 이면 **못 읽었다**. 「아무것도 안 켜져 있다」와 다르다. */
  enabledKeys: ReadonlySet<string> | null;
  inboxUrl: string | null;
}) {
  return (
    <section id="approval-mail" className="mt-10 scroll-mt-4 border-t border-zinc-200 pt-6 dark:border-zinc-800">
      <h2 className="text-sm font-semibold">결재 알림 메일</h2>
      <p className={`mt-1 ${NOTE}`}>
        새 결재 요청이 생기면 그 결재를 해야 할 사람에게 메일을 보냅니다. 어느 갈래에
        보낼지를 여기서 켜고 끕니다 — <strong className="font-medium">처음 상태는 전부
        꺼짐</strong>이고, 켠 갈래만 나갑니다.
      </p>

      {enabledKeys === null ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950"
        >
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            지금 설정을 읽을 수 없음
          </p>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            `approval_mail_kinds` 표를 읽지 못했습니다. 마이그레이션이 아직 적용되지
            않았을 수 있습니다. 🔴 켜고 끄는 일은 지금 할 수 없고,{" "}
            <strong className="font-medium">메일도 나가지 않습니다</strong>.
          </p>
        </div>
      ) : (
        <>
          <form action={saveApprovalMailKindSettings} className="mt-3">
            <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              {APPROVAL_MAIL_KINDS.map((entry, index) => {
                // 시스템이 바뀌는 자리에만 이름을 적는다. 갈래마다 적으면 같은
                // 이름이 세 줄 내리 서서 무엇이 묶여 있는지 오히려 안 보인다.
                const first =
                  index === 0 ||
                  APPROVAL_MAIL_KINDS[index - 1].systemLabel !== entry.systemLabel;
                return (
                  <div key={`${entry.clientId}:${entry.kind}`}>
                    {first ? (
                      <p
                        className={`${index === 0 ? "" : "mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800"} text-xs font-medium text-zinc-500`}
                      >
                        {entry.systemLabel}
                        <span className="ml-2 font-normal text-zinc-400">{entry.clientId}</span>
                      </p>
                    ) : null}
                    <label className="mt-1 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name={approvalKindFieldName(entry.clientId, entry.kind)}
                        defaultChecked={isApprovalMailKindEnabled(
                          enabledKeys,
                          entry.clientId,
                          entry.kind
                        )}
                        className="h-4 w-4"
                      />
                      <span className="text-zinc-900 dark:text-zinc-50">{entry.label}</span>
                    </label>
                  </div>
                );
              })}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="submit"
                className={`${BTN} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900`}
              >
                저장
              </button>
              {/* 브라우저의 폼 초기화 — 저장하지 않은 편집을 불러온 값으로 되돌린다. */}
              <button type="reset" className={`${BTN} ${BTN_PLAIN}`}>
                되돌리기
              </button>
            </div>
          </form>

          {/*
            🔴 시험 메일은 **따로 선 폼**이다. 위 폼 안에 두면 체크 상태가 함께
            실려 와 「저장도 되는가」를 헷갈리게 한다 — 이 단추는 아무것도 저장하지
            않고 메일 한 통만 보낸다.
          */}
          <form action={sendApprovalTestMail} className="mt-2">
            <button type="submit" className={`${BTN} ${BTN_PLAIN}`}>
              시험 메일 보내기
            </button>
            {/* 어디로 가는지 단추 옆에 늘 적어 둔다 — 「시험」이라는 말만 믿고
                누르면 누구에게 갔는지 알 수 없다. */}
            <span className={`ml-2 ${NOTE}`}>
              지금 로그인한 내 계정의 메일 주소로 한 통만 갑니다(예시 건수).
            </span>
          </form>
        </>
      )}

      <p className={`mt-3 ${NOTE}`}>
        🔴 메일 본문에는 <strong className="font-medium">건의 내용을 싣지 않습니다</strong> —
        고객사 · 금액 · 품명 · 사람 이름 · 인수번호는 한 글자도 나가지 않고, 갈래별
        건수와 승인함 주소만 적힙니다. 메일은 바깥 메일 서버를 거쳐 영구히 남고, 개인
        메일로 자동 전달을 걸어 둔 사람이 있으면 막을 길이 없기 때문입니다.
      </p>
      <p className={`mt-2 ${NOTE}`}>
        같은 결재는 <strong className="font-medium">한 번만</strong> 갑니다. 메일은 하루
        한 번 도는 작업이 보냅니다 — 결재가 생긴 그 순간이 아니라, 그 다음 작업 때
        나갑니다.
      </p>
      <p className={`mt-2 ${NOTE}`}>
        메일에 적는 승인함 주소:{" "}
        {inboxUrl === null ? (
          <span className="text-amber-700 dark:text-amber-400">
            아직 없습니다({APPROVAL_INBOX_URL_ENV} 를 적지 않았습니다). 메일은 나가되 주소
            줄만 빠집니다.
          </span>
        ) : (
          <span className="text-zinc-700 dark:text-zinc-300">{inboxUrl}</span>
        )}
      </p>
    </section>
  );
}

export default async function AdminNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; defaults?: string }>;
}) {
  const admin = await requirePortalAdmin();
  // 🔴 defaults 는 「이 시스템의 표를 기본값으로 그려 달라」는 표시일 뿐이다.
  // 값이 무엇이든 아래에서 clientId 와 맞춰 볼 뿐이라, 모르는 값이 와도 아무
  // 표도 달라지지 않는다.
  const { ok, error, defaults } = await searchParams;

  // 🔴 던지지 않는다 — 한 곳이 죽어도 이 화면은 떠야 한다. 죽은 시스템은
  // status: "unavailable" 로 담겨 온다(notifications/service.ts).
  const overview = await getNotificationSettings(admin.userId);

  /*
    분류만은 포털 DB 에서 읽는다(이 파일 머리말). 🔵 **표를 그릴 수 있는 시스템만**
    읽는다 — forbidden·unavailable 구역에는 표가 없어 그릴 칸도 없다.

    🔴 시스템마다 한 번씩 묻는다. 한 문장으로 모을 수도 있지만 다섯 줄짜리 조회
    다섯 번이고, 여는 사람이 관리자뿐이라 값이 싸다. 대신 저장 액션이 쓰는 조회와
    **같은 함수 하나**를 쓰게 된다 — 읽는 길이 둘로 갈리면 화면에 보이는 값과
    저장이 견주는 값이 어긋나는 날이 온다.

    🔵 던지는 것을 막지 않는다. 포털 DB 가 죽었다면 이 화면은 애초에 뜨지 않는다
    (requirePortalAdmin 이 같은 DB 를 먼저 읽는다).
  */
  const purposes = new Map(
    await Promise.all(
      overview.systems
        .filter((system) => system.status === "ok")
        .map(
          async (system) =>
            [system.clientId, await listKindPurposes(system.clientId)] as const
        )
    )
  );

  /*
    결재 알림 메일의 스위치. 🔴 **여기만 던지는 것을 막는다.**

    위 `purposes` 와 다른 까닭: 그 표는 이 화면이 처음 생길 때부터 있던 것이고,
    이 표(`approval_mail_kinds`)는 **마이그레이션이 아직 적용되지 않았을 수 있다.**
    적용 전에 이 화면을 열면 조회가 던지고, 그러면 **알림 설정 화면 전체가 500**
    이 된다 — 결재 메일과 아무 상관 없는 종 설정까지 함께 못 쓰게 된다.

    🔴 그렇다고 빈 집합으로 떨어뜨리지 않는다. 그러면 「아무것도 안 켜져 있다」로
    보이고, 그 표를 그대로 저장하면 사람이 켜 둔 갈래가 조용히 꺼진다. `null` 은
    「못 읽었다」는 뜻이고, 화면은 그 구역만 경고로 바꾼다.
  */
  let approvalMailKeys: ReadonlySet<string> | null = null;
  try {
    approvalMailKeys = await listEnabledApprovalMailKinds();
  } catch (error) {
    console.error("[approvals-mail] 켜 둔 갈래를 읽지 못했습니다:", error);
  }

  return (
    <main className="pt-8">
      <h1 className="text-xl font-semibold">알림 설정</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        시스템마다 <strong className="font-medium">어떤 알림을 쓸지</strong>와{" "}
        <strong className="font-medium">어느 역할이 받을지</strong>를 정합니다. 설정은
        각 시스템이 그대로 가지고 있고, 이 화면은 물어서 보여 주고 저장하면 그 시스템으로
        되돌려 보냅니다.
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
      {ok ? (
        <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          {ok}
        </p>
      ) : null}

      {overview.degraded ? (
        <p className={`mt-4 ${NOTE}`}>
          일부 시스템에 지금 물어볼 수 없습니다. 아래에서 그 구역만 표시됩니다.
        </p>
      ) : null}

      {overview.systems.length === 0 ? (
        <p className="mt-8 rounded-lg border border-zinc-200 px-4 py-6 text-sm text-zinc-500 dark:border-zinc-800">
          알림을 내주는 시스템이 없습니다. 알림 통로를 연 시스템 가운데 들어갈 수 있는
          곳이 없을 때 이렇게 보입니다.
        </p>
      ) : (
        overview.systems.map((system) => (
          <SystemBlock
            key={system.clientId}
            system={system}
            purposes={purposes.get(system.clientId) ?? NO_PURPOSES}
            showDefaults={defaults === system.clientId}
          />
        ))
      )}

      {/*
        🔴 **시스템 표들 다음이다.** 위는 「그 시스템이 가진 종 설정」이고 이것은
        「포털이 보내는 메일」이라, 섞어 두면 저장 단추가 어느 쪽 것인지 헷갈린다.
      */}
      <ApprovalMailBlock enabledKeys={approvalMailKeys} inboxUrl={readApprovalInboxUrl()} />

      <p className={`mt-10 border-t border-zinc-200 pt-4 ${NOTE} dark:border-zinc-800`}>
        알림 통로를 연 시스템만 나옵니다. 알림이 아예 없는 시스템은 여기에 줄이 생기지
        않습니다.
      </p>
    </main>
  );
}
