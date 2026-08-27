import type { Metadata } from "next";
import Link from "next/link";
import {
  AUDIT_LABELS,
  auditLabel,
  auditSummary,
  isNotable,
  type AuditAction,
} from "@/lib/auth/audit-labels";
import { requirePortalAdmin } from "@/lib/auth/portal-admin";
import {
  AUDIT_PAGE_SIZE,
  auditStorageSummary,
  listAuditLogs,
  tallyRecentAudit,
} from "@/lib/db/queries/audit-logs";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "감사 기록 | DSS 통합 로그인" };

/** 요약 줄에 세는 기간. 한 달이면 "요즘 이상한가"에 답하기에 충분하다. */
const TALLY_DAYS = 30;

const ALL_ACTIONS = Object.keys(AUDIT_LABELS) as AuditAction[];
const NOTABLE_ACTIONS = ALL_ACTIONS.filter(isNotable);

const CHIP =
  "rounded-md border px-2.5 py-1 text-xs transition-colors";
const CHIP_OFF =
  "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900";
const CHIP_ON =
  "border-zinc-900 bg-zinc-900 text-zinc-50 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900";

/** 주소창의 값은 믿지 않는다 — 아는 유형만 통과시킨다. */
function parseFilter(raw: string | undefined): AuditAction[] {
  if (!raw) return [];
  if (raw === "notable") return NOTABLE_ACTIONS;
  const known = new Set<string>(ALL_ACTIONS);
  return raw
    .split(",")
    .filter((value) => known.has(value)) as AuditAction[];
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; before?: string }>;
}) {
  await requirePortalAdmin();

  const { filter, before } = await searchParams;
  const actions = parseFilter(filter);

  // 주소창에서 온 시각이라 그대로 믿지 않는다. 파싱에 실패하면 필터가 없는
  // 것으로 다룬다 — 오류 화면을 띄우는 것보다 첫 쪽을 보여주는 편이 낫다.
  const beforeDate = before ? new Date(before) : undefined;
  const validBefore =
    beforeDate && !Number.isNaN(beforeDate.getTime()) ? beforeDate : undefined;

  const [rows, tally, storage] = await Promise.all([
    listAuditLogs({ actions, before: validBefore }),
    tallyRecentAudit(TALLY_DAYS),
    auditStorageSummary(),
  ]);

  const tallyMap = new Map(tally.map((row) => [row.actionType, row.n]));
  const notableRecent = NOTABLE_ACTIONS.map((action) => ({
    action,
    n: tallyMap.get(action) ?? 0,
  })).filter((row) => row.n > 0);

  const hasMore = rows.length === AUDIT_PAGE_SIZE;
  const last = rows.at(-1);

  function href(next: { filter?: string; before?: string }): string {
    const params = new URLSearchParams();
    if (next.filter) params.set("filter", next.filter);
    if (next.before) params.set("before", next.before);
    const query = params.toString();
    return query ? `/admin/audit?${query}` : "/admin/audit";
  }

  return (
    <main className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold">감사 기록</h1>
        <p className="text-xs text-zinc-500">
          전체 {storage.total.toLocaleString()}건
          {storage.oldest ? ` · 가장 오래된 기록 ${formatDateTime(storage.oldest)}` : ""}
          {" · 보관 3년"}
        </p>
      </div>

      {/* 최근 한 달의 주목할 일. 아무것도 없으면 그 사실 자체가 답이다. */}
      <section className="mt-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-xs font-medium text-zinc-500">
          최근 {TALLY_DAYS}일 · 눈여겨볼 일
        </h2>
        {notableRecent.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            없습니다.
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
            {notableRecent.map(({ action, n }) => (
              <li key={action} className="text-sm">
                <Link
                  href={href({ filter: action })}
                  className="text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300"
                >
                  {auditLabel(action)}
                </Link>{" "}
                <span className="font-semibold tabular-nums text-amber-700 dark:text-amber-500">
                  {n}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <Link href={href({})} className={`${CHIP} ${!filter ? CHIP_ON : CHIP_OFF}`}>
          전체
        </Link>
        <Link
          href={href({ filter: "notable" })}
          className={`${CHIP} ${filter === "notable" ? CHIP_ON : CHIP_OFF}`}
        >
          눈여겨볼 일만
        </Link>
        {NOTABLE_ACTIONS.map((action) => (
          <Link
            key={action}
            href={href({ filter: action })}
            className={`${CHIP} ${filter === action ? CHIP_ON : CHIP_OFF}`}
          >
            {auditLabel(action)}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
          해당하는 기록이 없습니다.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {rows.map((row) => {
            const summary = auditSummary(row);
            const notable = isNotable(row.actionType);
            return (
              <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="w-36 shrink-0 tabular-nums text-xs text-zinc-500">
                  {formatDateTime(row.createdAt)}
                </span>
                <span
                  className={
                    notable
                      ? "font-medium text-amber-700 dark:text-amber-500"
                      : "text-zinc-700 dark:text-zinc-300"
                  }
                >
                  {auditLabel(row.actionType)}
                </span>
                {/* 행위자가 없는 줄은 숨기지 않고 그렇게 적는다 — 시스템이
                    한 일과 사람이 한 일은 다르게 읽혀야 한다. */}
                <span className="text-zinc-600 dark:text-zinc-400">
                  {row.actorName ?? "(시스템)"}
                </span>
                {summary ? (
                  <span className="text-zinc-500 dark:text-zinc-500">{summary}</span>
                ) : null}
                {row.clientId ? (
                  <span className="rounded border border-zinc-200 px-1.5 text-xs text-zinc-500 dark:border-zinc-700">
                    {row.clientId}
                  </span>
                ) : null}
                {row.sourceIp ? (
                  <span
                    className="ml-auto text-xs tabular-nums text-zinc-400 dark:text-zinc-600"
                    title={row.userAgent ?? undefined}
                  >
                    {row.sourceIp}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && last ? (
        <div className="mt-4 text-center">
          <Link
            href={href({ filter, before: last.createdAt.toISOString() })}
            className="inline-block rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            이전 기록 더 보기
          </Link>
        </div>
      ) : null}
    </main>
  );
}
