import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NotificationBell } from "@dss/ui";
import SignOutButton from "@/components/SignOutButton";
import { hasNewApprovalsForTile } from "@/lib/approvals/screen-service";
import { isApprovalsTile } from "@/lib/approvals/tile-dot";
import { listAccessibleClients } from "@/lib/db/queries/clients";
import { shouldShowTileDot, type PortalNotificationFeed } from "@/lib/notifications/merge";
import { getNotificationFeed } from "@/lib/notifications/service";
import { APP_VERSION } from "@/lib/release-notes";
import {
  acknowledgeNotificationAction,
  dismissNotificationAction,
} from "@/lib/server/actions/notification-bell";
import { readSsoSession } from "@/lib/session/sso-session";

export const metadata: Metadata = { title: "시스템 목록 | DSS 통합 로그인" };

/**
 * 타일 한 장의 오른쪽 위에 앉는 **작은 빨간 동그라미.**
 *
 * 숫자가 아니라 점이다 — 「아직 확인하지 않은 것이 있다」만 알리면 되고,
 * 몇 건인지는 들어가서 종을 열면 시스템이 제대로 세어 준다(2026-09-23 요구).
 *
 * 🔴 **`"use client"` 가 아니다.** 이 저장소에는 그 줄이 한 곳에도 없고,
 * 점 하나 때문에 들일 것도 아니다. 서버에서 그려 흘려보낸다.
 *
 * 🔴 넘겨받는 것은 **아직 풀리지 않은 약속(promise)** 이다. 부모는 이것을
 * 기다리지 않고 타일을 먼저 내보내고, 이 조각만 `<Suspense>` 안에서 나중에
 * 흘러 들어온다. 타일 수만큼 이 조각이 있어도 물어보는 것은 **한 번뿐**이다 —
 * 부모가 만든 약속 하나를 모두가 나눠 본다.
 *
 * 켤지 말지를 정하는 규칙은 화면에 묻지 않고 merge.ts 의 shouldShowTileDot 에
 * 있다(0건 · 못 물어봄 · 통로 없음 · 점을 안 찍는 시스템 — 갈래를 시험으로
 * 돌려 봐야 한다). 🔴 **이 파일에는 시스템 이름이 한 글자도 없다** — 지금은
 * 개선요청에만 점이 뜨지만(2026-09-23 사용자 결정), 그 결정은 merge.ts 의
 * 목록 한 줄이라 화면은 넓히든 좁히든 고칠 것이 없다.
 */
async function UnreadDot({
  feed,
  clientId,
}: {
  feed: Promise<PortalNotificationFeed | null>;
  clientId: string;
}) {
  const resolved = await feed;
  if (resolved === null || !shouldShowTileDot(resolved.sources, clientId)) return null;

  return (
    <span className="absolute right-4 top-4 flex items-center">
      <span className="h-2.5 w-2.5 rounded-full bg-red-500" aria-hidden="true" />
      {/*
        🔴 눈으로만 아는 표시는 안 된다. 화면 낭독기에는 이 글자가 링크 이름
        끝에 붙어 「DSS 개선요청 … 확인하지 않은 알림이 있습니다」로 읽힌다.
      */}
      <span className="sr-only">확인하지 않은 알림이 있습니다</span>
    </span>
  );
}

/**
 * 승인함 타일에만 붙는 **「새 결재」 표시.**
 *
 * ── 🔴 색만으로 알리지 않는다 ────────────────────────────────────────────
 * 점 옆에 **「새 결재」라는 글자**가 함께 뜬다. 위 UnreadDot 은 점만 찍고 글자를
 * `sr-only` 로 숨기지만, 그쪽은 「확인하지 않은 알림」이라 들어가 보면 알 수 있는
 * 것이고 이쪽은 **결재**다 — 빨강을 못 가리는 사람에게도, 작은 화면에서 아이콘이
 * 뭉쳐 보일 때도 무엇이 기다리는지 한눈에 읽혀야 한다. `title` 은 마우스를 얹은
 * 사람 몫의 한 문장이다.
 *
 * ── 🔵 개수를 적지 않는 까닭 ─────────────────────────────────────────────
 * 숫자를 적으려면 **모든 줄이 성해야** 한다. 그런데 한 시스템이 못 답하면 그쪽
 * 결재는 애초에 목록에 없고(screen-gather.ts 의 `failed`), 열쇠가 없는 줄은
 * 버려진다(screen-inbox.ts 의 `dropped`). 그 상태에서 「3건」이라고 적으면 들어가
 * 보는 화면의 숫자와 다르고, **틀린 숫자는 점이 거짓말하는 것보다 나쁘다.**
 * 「새 결재」는 한 줄만 맞으면 참이다.
 *
 * 🔴 **승인함이 아닌 타일에서는 약속을 기다리지도 않는다**(아래 첫 줄). 그래서
 * 나머지 여덟 타일은 이 조각 때문에 한 순간도 늦어지지 않는다. 🔴 어느 타일인지
 * 아는 것은 tile-dot.ts 이고 **이 파일에는 시스템 이름이 한 글자도 없다** — 위
 * UnreadDot 과 같은 규율이다.
 */
async function NewApprovalBadge({
  dot,
  clientId,
}: {
  dot: Promise<boolean>;
  clientId: string;
}) {
  if (!isApprovalsTile(clientId)) return null;
  if (!(await dot)) return null;

  return (
    <span
      className="absolute right-4 top-4 flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400"
      title="확인하지 않은 새 결재가 있습니다"
    >
      <span className="h-2.5 w-2.5 rounded-full bg-red-500" aria-hidden="true" />
      새 결재
    </span>
  );
}

/**
 * 머리말 **오른쪽 끝**에 앉는 알림 종(@dss/ui 의 NotificationBell).
 *
 * 사용자 요구는 한 줄이었다(2026-11-18): 「포털 화면에도 종 알람이 뜨도록」.
 * 백엔드는 이미 다 있었다 — `getNotificationFeed` 가 **모든 시스템의 알림**을
 * 모으고, 어느 시스템에 물을지는 **앱 런처 타일과 같은 판정**으로 이미 좁혀져
 * 있다(service.ts 의 sourcesFor → listAccessibleClients). 여기서 하는 일은
 * 그 결과를 **그대로** 넘기는 것뿐이다.
 *
 * 🔴 **옮겨 담는 코드가 한 줄도 없다.** 포털이 내주는 한 줄
 * (`PortalNotificationItem`)과 종이 받는 한 줄(`NotificationBellItem`)은 앞의
 * 아홉 칸이 **글자까지 같다** — 그 타입이 일부러 이쪽의 거울로 지어졌기
 * 때문이다(@dss/ui 의 notification-bell/types.ts). 베껴 담는 코드가 생기는
 * 순간 그 묶음을 만든 까닭이 사라진다.
 *
 * ── 🔴 `"use client"` 가 아니다 ──────────────────────────────────────────
 * 펼치고 접는 일은 `<details>` 라 **브라우저가 스스로** 한다. 그래서 이 조각은
 * 서버 컴포넌트로 남고, 스크립트가 아직 안 붙은 화면에서도 종을 열어 읽을 수
 * 있다. 🔴 그 대신 아래 두 함수 자리에 넘길 수 있는 것은 **서버 액션뿐이다**
 * (평범한 함수는 클라이언트 경계를 건너지 못한다).
 *
 * ── 🔴 알림이 없으면 **종 자체가 없다**(@dss/ui 의 기본값) ────────────────
 * `showWhenEmpty` 를 넘기지 않았다 — 알림이 0건인 사람에게는 머리말에 종이
 * 아예 안 뜬다. 그래서 `emptyLabel`(「새 알림이 없습니다」 같은 말)도 쓸 자리가
 * 없다. 고른 까닭 넷:
 *
 *  1. 🔴 **빈 종을 세워도 자리가 안 지켜진다.** 이 조각은 `<Suspense>` 뒤에
 *     있고 그 `fallback` 이 `null` 이라, 첫 그림에는 어차피 종이 없다 — 늦게
 *     흘러 들어오면서 옆 단추들이 한 번 밀리는 것은 **어느 쪽을 골라도
 *     똑같다.** 「자리를 지킨다」는 이득이 여기서는 생기지 않는다.
 *  2. `/apps` 는 **머무는 화면이 아니다.** 타일을 눌러 다른 시스템으로 건너가는
 *     통과 지점이라, 다른 집들처럼 모든 업무 화면 머리말에 종이 서 있는 것과
 *     사정이 다르다. 한 번 보고 지나가는 자리에 「눌러도 아무것도 없는 단추」를
 *     남길 값어치가 없다.
 *  3. 포털에는 **점이 따로 있다**(아래 UnreadDot). 「지금 밀린 일이 없다」를
 *     알리는 일은 이미 점의 부재가 하고 있어서, 빈 종은 같은 말을 두 번 한다.
 *  4. 종을 단 다른 집들 가운데 **빈 종을 세우는 곳은 A/S 하나뿐이다**(실측
 *     2026-11-18 — `showWhenEmpty` 를 넘기는 곳이 거기 한 군데다). 그쪽은 펼친
 *     칸 아래에 **브라우저 알림 권한 안내**를 끼워 넣어서 알림이 없어도 그
 *     자리가 필요하다(그 파일의 그 자리 주석). 포털에는 거기 넣을 것이 없다.
 *
 * 🔵 **그래서 「알림이 0건이면 종이 안 보이는 것」이 정상이다.** 눈으로 볼 때
 *    종이 없다고 고장을 의심하지 않도록 적어 둔다.
 *
 * ── 🔴 `colorScheme="system"` 을 넘기는 까닭 ─────────────────────────────
 * 기본값 `"host"` 는 조상에 `.dark` 나 `[data-theme="dark"]` 가 있을 때만
 * 어두워지는데, **이 포털에는 그런 표시가 없다.** 여기 다크는 globals.css 의
 * `@media (prefers-color-scheme: dark)` 와 Tailwind 의 `dark:` 유틸리티로
 * 도므로 OS 설정을 바로 따른다. 기본값으로 두면 OS 가 어두운 사람의 화면에서
 * **종만 하얗게** 남는다. 🔵 다크를 새로 더하는 것이 아니라 이미 도는 것에
 * 맞추는 한 낱말이다.
 *
 * ── 🔴 「보이는 알림 지우기」(onDismissAll)는 넘기지 않는다 ───────────────
 * 안 넘기면 그 단추가 아예 안 그려진다(@dss/ui). 이번 조각의 범위가 아니고,
 * 넘기려면 지금 그리는 열쇠 목록을 미리 묶은 액션이 하나 더 있어야 한다.
 * 줄마다 서는 ✕ 와 따로 도는 자리라 나중에 더해도 여기 한 줄이다.
 */
async function HeaderBell({ feed }: { feed: Promise<PortalNotificationFeed | null> }) {
  const resolved = await feed;
  // 못 물어봤으면 그리지 않는다. 🔵 `getNotificationFeed` 는 던지지 않게
  // 지어져 있으므로(service.ts) 이 갈래는 부모의 `.catch` 가 세우는 것이다.
  if (resolved === null) return null;

  return (
    <NotificationBell
      // 🔴 **받은 그대로**다. 차례도 개수도 포털이 이미 정해 두었다 — 여기서
      //    다시 세면 각 시스템의 종과 이 종이 서로 다른 숫자를 말하게 된다
      //    (@dss/ui 의 count 주석).
      items={resolved.items}
      count={resolved.count}
      colorScheme="system"
      // 🔴 줄을 누르면 「해소됐다」를 포털에 적는다. 🔵 **눌러도 안 사라지는
      //    줄이 있다** — 승인용으로 분류된 종류는 기록만 남고 종에 남는다
      //    (그 액션 머리말).
      onAcknowledge={acknowledgeNotificationAction}
      // 🔴 이것을 **넘겼을 때만** 줄마다 ✕ 가 그려진다. 🔵 `canDismiss` 는
      //    넘기지 않는다 = 모든 줄에 ✕ 가 선다. 포털은 어느 줄이 「처리해야
      //    사라지는 것」인지 가리지 않는다 — 같은 줄이 다른 시스템의 종에서는
      //    어차피 지워지므로, 여기서만 막는 것은 헷갈리게 만드는 일이다.
      onDismiss={dismissNotificationAction}
    />
  );
}

/**
 * 머리말 오른쪽에 서는 단추들(「사용자 관리」·「로그아웃」)의 모양.
 *
 * 🔴 높이 `h-9`(36px)는 **종에 맞춘 값**이다 — @dss/ui 의 `.dss-bell__summary`
 * 가 36px 정사각이라 그 옆에 20px 남짓한 밑줄 링크를 두면 종만 혼자 커서 줄이
 * 어긋나 보인다(2026-11-18 사용자 지적). 🔵 종이 좁은 화면에서 40px 로 커지는
 * 것은 그대로 둔다 — 그때는 글자 단추도 손가락에 맞게 커지는 편이 낫다.
 *
 * 🔴 **두 곳이 같은 값을 쓰므로 상수 하나로 둔다.** 한쪽만 고치면 키가 다시
 * 어긋나는데, 그 어긋남은 오류 없이 화면에서만 드러난다.
 *
 * 🔵 `/pending` 의 로그아웃은 **안 바뀐다** — 거기엔 종이 없어 맞출 상대가
 * 없고, 이번 지시의 범위도 이 화면 하나다. `SignOutButton` 이 className 을
 * 받지 않으면 지금까지의 밑줄 모양 그대로 그린다.
 */
const HEADER_ACTION_CLASS =
  "inline-flex h-9 items-center rounded-md border border-zinc-300 px-3 text-sm " +
  "text-zinc-700 transition-colors hover:bg-zinc-50 hover:text-zinc-900 " +
  "dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";

export default async function AppsPage() {
  const session = await readSsoSession();
  if (!session) redirect("/signin");
  if (session.status !== "ACTIVE") redirect("/pending");

  const tiles = await listAccessibleClients(session.userId);

  /*
    🔴 **일부러 await 하지 않는다.** 이 한 줄은 각 시스템에 HTTP 왕복이고,
    캐시가 비면 1.5초까지 걸린다(gather.ts 의 READ_TIMEOUT_MS). 여기서 기다리면
    포털의 첫 화면이 남의 서버 사정만큼 느려진다 — 지금은 DB 조회 한 번으로
    끝나는 화면이다. 약속만 만들어 두고 아래 `<Suspense>` 에 넘기면 타일이
    먼저 뜨고 점만 0.2초쯤 뒤에 켜진다. 그 지연은 아무도 눈치채지 못한다.

    .catch 를 붙이는 까닭: getNotificationFeed 는 던지지 않게 만들어져 있지만
    (service.ts), 만약 던지더라도 그것이 **첫 화면을 깨서는 안 된다.** null 은
    「못 물어봤다」와 같은 뜻이고, 그때 점은 그리지 않는다.
  */
  const feed = getNotificationFeed(session.userId).catch(
    (): PortalNotificationFeed | null => null
  );

  /*
    승인함 타일의 「새 결재」 표시. 🔴 **위 feed 와 같은 규율이다** — 기다리지
    않고 약속만 만들어 `<Suspense>` 에 넘긴다. 세 시스템에 묻는 왕복이라
    여기서 await 하면 첫 화면이 남의 서버 사정만큼 느려진다.

    🔴 **승인함 타일이 없는 사람에게는 아예 묻지 않는다.** 들어갈 수 없는
    사람(또는 승인함이 아직 clients 에 등록되기 전)에게 세 시스템을 두드려 봐야
    그릴 자리가 없다. 🔵 이때 약속을 `null` 로 두지 않고 **false 로 채운** 까닭은
    아래 조각의 인자 타입을 갈래 없이 하나로 두기 위해서다.

    .catch 를 붙이는 까닭도 feed 와 같다: 그 함수는 던지지 않게 만들어져 있지만
    (tile-dot.ts), 만약 던지더라도 그것이 **첫 화면을 깨서는 안 된다.** 못 쟀을
    때의 답은 언제나 「점 없음」이다.
  */
  const approvalDot = tiles.some((tile) => isApprovalsTile(tile.clientId))
    ? hasNewApprovalsForTile(session.userId).catch(() => false)
    : Promise.resolve(false);

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">DSS 시스템</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {session.displayName}님
            {session.isPortalAdmin ? " · 포털 관리자" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {session.isPortalAdmin ? (
            <Link href="/admin/users" className={HEADER_ACTION_CLASS}>
              사용자 관리
            </Link>
          ) : null}
          <SignOutButton className={HEADER_ACTION_CLASS} />
          {/*
            🔴 **줄의 맨 오른쪽 끝**이다. 펼친 목록은 종에 오른쪽 끝을 맞춰
            왼쪽으로 펼쳐지므로(@dss/ui 의 `.dss-bell__list { right: 0 }`),
            가운데쯤에 앉으면 폰에서 목록 왼쪽이 화면 밖으로 잘린다. 종을 단
            다른 집들이 전부 같은 자리에 두고 있다.

            🔴 **래퍼 <div> 로 감싸지 않는다.** 감싸면 알림이 없어 종이
            그려지지 않을 때도 flex 항목 하나와 gap 16px 이 남는다.

            🔴 **여기서 await 하지 않는다** — 위 feed 와 같은 규율이다. 약속만
            넘기고 기다리는 일은 `<Suspense>` 안쪽에서 일어난다. 여기서
            기다리면 각 시스템에 가는 HTTP 왕복(캐시가 비면 1.5초)만큼 포털의
            **첫 화면 전체**가 늦어진다.
          */}
          <Suspense fallback={null}>
            <HeaderBell feed={feed} />
          </Suspense>
        </div>
      </header>

      {tiles.length === 0 ? (
        <p className="mt-10 rounded-lg border border-dashed border-zinc-300 px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          아직 연결된 시스템이 없습니다.
        </p>
      ) : (
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {tiles.map((tile) => (
            <li key={tile.clientId}>
              <a
                href={tile.launcherUrl ?? "#"}
                className="relative flex h-full flex-col rounded-xl border border-zinc-200 p-5 transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <span className="text-2xl" aria-hidden="true">
                  {tile.launcherIcon ?? "🔗"}
                </span>
                <span className="mt-3 font-medium">{tile.name}</span>
                {tile.description ? (
                  <span className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                    {tile.description}
                  </span>
                ) : null}
                {/*
                  점은 카드 위에 얹는다(카드가 relative, 점이 absolute) — 아이콘
                  줄을 flex 로 고쳐 오른쪽에 두는 방법도 있지만, 그러면 점이
                  없을 때도 그 줄의 구조가 바뀐다. 얹으면 점이 없는 타일의
                  마크업이 예전과 한 글자도 다르지 않다.

                  DOM 에서는 이름·설명 **뒤**에 둔다. 눈에 보이는 자리는 위쪽
                  오른편이지만, 낭독기는 이름을 먼저 읽고 나서 「확인하지 않은
                  알림이 있습니다」를 듣는 편이 자연스럽다.
                */}
                <Suspense fallback={null}>
                  <UnreadDot feed={feed} clientId={tile.clientId} />
                </Suspense>
                {/*
                  🔵 둘이 같은 자리(`right-4 top-4`)를 쓰지만 **겹칠 일이 없다** —
                  위 점은 알림 통로를 가진 시스템에만 뜨고(merge.ts 의 목록),
                  이 글자는 승인함에만 뜬다. 승인함에는 알림 통로가 없다.
                */}
                <Suspense fallback={null}>
                  <NewApprovalBadge dot={approvalDot} clientId={tile.clientId} />
                </Suspense>
              </a>
            </li>
          ))}
        </ul>
      )}

      {/*
        머리말이 아니라 여기에 둔다. 위쪽은 이름·사용자 관리·로그아웃으로 이미
        좁고, 버전은 찾을 때만 보면 되는 것이라 목록 끝이 제자리다.
      */}
      <Link
        href="/release-notes"
        className="mt-10 inline-block text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        v{APP_VERSION} · 업데이트 소식
      </Link>
    </main>
  );
}
