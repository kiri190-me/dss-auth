import type { Metadata } from "next";
import Link from "next/link";
import { formatReleaseDate } from "@/lib/format";
import {
  APP_VERSION,
  FOLDER_HELPER_NOTICE,
  RELEASES,
  type ReleaseKind,
  type ReleaseSystem,
} from "@/lib/release-notes";

export const metadata: Metadata = {
  title: "업데이트 소식 | DSS 통합 로그인",
  // 로그인 화면과 같은 이유로 색인하지 않는다. 사내 사람이 보라고 만든 글이지
  // 검색 결과에 뜨라고 만든 글이 아니다.
  robots: { index: false, follow: false },
};

/**
 * 갈래별 색.
 *
 * 로그인 화면의 오류 배너(signin/page.tsx)가 쓰는 라이트/다크 짝 모양을 그대로
 * 따랐다. 이 저장소의 다크 모드는 OS 설정을 그대로 따르므로 dark: 변형을
 * 빠뜨리면 흰 바탕에 흰 글자가 된다 — 실제로 관리 화면에서 한 번 겪은 일이다.
 *
 * 클래스를 문자열 조합으로 만들지 않고 통째로 적어 둔다. Tailwind 는 소스에
 * 적힌 글자를 찾아 CSS 를 만들기 때문에, `bg-${color}-50` 처럼 쓰면 그 색이
 * 빌드 결과에서 통째로 빠진다.
 */
const KIND_CHIP: Record<ReleaseKind, string> = {
  추가: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300",
  개선: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  고침: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
};

/**
 * 시스템 칩 색. 갈래 칩(KIND_CHIP)과 같은 이유로 클래스를 통째로 적는다 —
 * 문자열을 조합하면 Tailwind 가 그 색을 빌드 결과에서 빼 버린다.
 * 갈래 칩(파랑 · 초록 · 노랑)과 부딪히지 않게 회색 계열 한 벌로 두고, 글자로 가른다.
 */
const SYSTEM_CHIP: Record<ReleaseSystem, string> = {
  "통합 로그인":
    "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
  "A/S 관리":
    "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
  "계측기 관리":
    "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
  개선요청:
    "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
  "PO / 내자":
    "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
};

export default function ReleaseNotesPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <header>
        <h1 className="text-xl font-semibold">업데이트 소식</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          사내 시스템이 바뀔 때마다 여기에 적습니다. 지금 보고 계신 로그인 화면은{" "}
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            v{APP_VERSION}
          </span>{" "}
          입니다.
        </p>
      </header>

      {/*
        🔴 **소식 목록보다 위에, 늘 여기 있는 칸**(2026-10-12 사용자 결정).
        소식 글 하나로 넣으면 다음 배포에 밀려 내려간다 — 까닭과 문구는
        release-notes.ts 의 FOLDER_HELPER_NOTICE 머리말에 있다.

        🔴 단추는 포털 제 화면(`/apps`)으로만 간다. 이 화면은 로그인 없이도
        열리므로 사내 주소를 그리지 않는다. 설치 명령을 만드는 쪽은 그대로 A/S 다.
      */}
      <details className="mt-8 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
        {/*
          🔴 접기는 `<details>` 다 — 자바스크립트가 한 줄도 들어가지 않는다. 이 저장소에는
          `"use client"` 가 한 곳도 없고(apps/page.tsx 의 그 주석), 접기 하나 때문에 그 틀을
          들일 일이 아니다. 같은 까닭으로 admin 화면들이 이미 `<details>` 를 쓴다.

          🔴 **처음은 접힌 채다**(`open` 이 없다 — 사용자 결정 2026-10-12: 「기본적으로는
          접혀져 있도록」). 한 번 설치하면 다시 볼 일이 없는 글이라, 펴 둔 채로는 소식을
          읽으러 온 사람 모두의 화면 맨 위를 차지한다.

          🔴 그래서 `<summary>` 에 **제목과 한 줄 설명을 함께** 둔다. 접힌 상태에서 제목만
          덩그러니 있으면 안에 무엇이 있는지 몰라 아무도 펴 보지 않는다 — 그러면 이 칸을
          최상단에 세운 까닭이 사라진다. 🔴 한 줄로 끝낸다(release-notes.ts 의 `summary`).

          🔴 접은 상태는 **기억하지 않는다**(기억시키려면 localStorage → 클라이언트 조각).
          기본이 접힘이 된 지금은 기억할 것도 거의 없다 — 기억의 쓸모는 「접어 둔 것이
          다시 펴지지 않게」인데, 애초에 펴지지 않는다.

          제목은 접혀도 **늘 보인다** — 자리도 그대로 최상단이라 「상시 노출」이 산다.
        */}
        <summary className="cursor-pointer">
          <h2 className="inline text-sm font-semibold">
            {FOLDER_HELPER_NOTICE.title}
          </h2>
          <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
            {FOLDER_HELPER_NOTICE.summary}
          </span>
        </summary>
        {FOLDER_HELPER_NOTICE.body.map((paragraph) => (
          <p
            key={paragraph}
            className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400"
          >
            {paragraph}
          </p>
        ))}
        <Link
          href={FOLDER_HELPER_NOTICE.linkHref}
          className="mt-4 inline-block rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:border-zinc-900 dark:border-zinc-700 dark:hover:border-zinc-400"
        >
          {FOLDER_HELPER_NOTICE.linkText}
        </Link>
      </details>

      <ol className="mt-10 space-y-8">
        {RELEASES.map((release) => (
          <li
            key={`${release.system}-${release.version}`}
            className="border-t border-zinc-200 pt-8 first:border-t-0 first:pt-0 dark:border-zinc-800"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {/*
                어느 시스템의 소식인지 먼저 밝힌다 — 번호만 있으면 A/S 1.3 과
                통합 로그인 1.3 을 같은 것으로 읽게 된다.
              */}
              <span
                className={`rounded-md border px-2 py-0.5 text-xs font-medium ${SYSTEM_CHIP[release.system]}`}
              >
                {release.system}
              </span>
              <h2 className="text-lg font-semibold">v{release.version}</h2>
              <time
                dateTime={release.date}
                className="text-sm text-zinc-500 dark:text-zinc-400"
              >
                {formatReleaseDate(release.date)}
              </time>
            </div>

            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {release.title}
            </p>

            <ul className="mt-4 space-y-2.5">
              {release.items.map((item) => (
                <li key={item.text} className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${KIND_CHIP[item.kind]}`}
                  >
                    {item.kind}
                  </span>
                  <span className="text-sm leading-relaxed">{item.text}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>

      {/*
        "/" 로 보낸다. 루트가 세션을 보고 /apps 나 /signin 으로 가르므로,
        로그인 전에 들어왔든 후에 들어왔든 각자 맞는 자리로 돌아간다.
      */}
      <Link
        href="/"
        className="mt-12 inline-block text-sm text-zinc-500 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        ← 돌아가기
      </Link>
    </main>
  );
}
