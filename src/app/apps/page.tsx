import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import SignOutButton from "@/components/SignOutButton";
import { listAccessibleClients } from "@/lib/db/queries/clients";
import { shouldShowTileDot, type PortalNotificationFeed } from "@/lib/notifications/merge";
import { getNotificationFeed } from "@/lib/notifications/service";
import { APP_VERSION } from "@/lib/release-notes";
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

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">사내 시스템</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {session.displayName}님
            {session.isPortalAdmin ? " · 포털 관리자" : ""}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {session.isPortalAdmin ? (
            <Link
              href="/admin/users"
              className="text-sm text-zinc-500 underline underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              사용자 관리
            </Link>
          ) : null}
          <SignOutButton />
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
