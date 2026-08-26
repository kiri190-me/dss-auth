import type { Metadata } from "next";
import { requirePortalAdmin } from "@/lib/auth/portal-admin";
import { listUsersForAdmin, type AdminUserRow } from "@/lib/db/queries/admin-users";
import { formatDateTime } from "@/lib/format";
import {
  approveUser,
  reactivateUser,
  setPortalAdmin,
  suspendUser,
  updateUserProfile,
} from "@/lib/server/actions/admin-users";

export const metadata: Metadata = { title: "사용자 관리 | DSS 통합 로그인" };

const INPUT =
  "w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700";
const LABEL = "block text-xs font-medium text-zinc-500";
const BTN =
  "rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40";
const BTN_PLAIN =
  "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900";

const PROVIDER_LABELS: Record<string, string> = {
  KAKAO: "카카오",
  EMERGENCY: "비상계정",
  LDAP: "LDAP",
};

function ProviderBadges({ providers }: { providers: string | null }) {
  if (!providers) {
    // 신원이 하나도 없는 행은 정상 경로로는 생기지 않는다. 숨기지 않고
    // 눈에 띄게 표시해 관리자가 이상을 알아챌 수 있게 한다.
    return <span className="text-xs text-amber-600">로그인 수단 없음</span>;
  }
  const names = providers
    .split(",")
    .map((code) => PROVIDER_LABELS[code] ?? code)
    .join(" · ");
  return <span className="text-xs text-zinc-500">{names}</span>;
}

function ProfileFields({ user }: { user: AdminUserRow }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className={LABEL} htmlFor={`name-${user.id}`}>
          실명 <span className="text-red-500">*</span>
        </label>
        <input
          id={`name-${user.id}`}
          name="displayName"
          defaultValue={user.displayName}
          required
          maxLength={50}
          className={`${INPUT} mt-1`}
        />
      </div>
      <div>
        <label className={LABEL} htmlFor={`dept-${user.id}`}>
          소속
        </label>
        <input
          id={`dept-${user.id}`}
          name="department"
          defaultValue={user.department ?? ""}
          maxLength={50}
          className={`${INPUT} mt-1`}
        />
      </div>
      <div>
        <label className={LABEL} htmlFor={`empno-${user.id}`}>
          사번
        </label>
        <input
          id={`empno-${user.id}`}
          name="employeeNo"
          defaultValue={user.employeeNo ?? ""}
          maxLength={30}
          className={`${INPUT} mt-1`}
        />
      </div>
      <div>
        <label className={LABEL} htmlFor={`email-${user.id}`}>
          이메일
        </label>
        <input
          id={`email-${user.id}`}
          name="email"
          type="email"
          defaultValue={user.email ?? ""}
          maxLength={100}
          className={`${INPUT} mt-1`}
        />
      </div>
    </div>
  );
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const admin = await requirePortalAdmin();
  const { ok, error } = await searchParams;
  const all = await listUsersForAdmin();

  const pending = all.filter((user) => user.status === "PENDING");
  const active = all.filter((user) => user.status === "ACTIVE");
  const suspended = all.filter((user) => user.status === "SUSPENDED");

  return (
    <main className="pt-8">
      <h1 className="text-xl font-semibold">사용자 관리</h1>

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

      <section className="mt-8">
        <h2 className="text-sm font-semibold">
          승인 대기 <span className="text-zinc-500">{pending.length}</span>
        </h2>
        {pending.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">승인을 기다리는 사람이 없습니다.</p>
        ) : (
          <ul className="mt-3 space-y-4">
            {pending.map((user) => (
              <li
                key={user.id}
                className="rounded-xl border border-amber-300 p-5 dark:border-amber-800"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{user.displayName}</span>
                  <span className="text-xs text-zinc-500">
                    {formatDateTime(user.createdAt)} 신청 ·{" "}
                    <ProviderBadges providers={user.providers} />
                  </span>
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  카카오 닉네임이 그대로 들어와 있습니다. 실명으로 고쳐서 승인하세요.
                </p>
                <form action={approveUser} className="mt-4 space-y-3">
                  <input type="hidden" name="userId" value={user.id} />
                  <ProfileFields user={user} />
                  <button
                    type="submit"
                    className={`${BTN} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900`}
                  >
                    승인
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold">
          사용 중 <span className="text-zinc-500">{active.length}</span>
        </h2>
        <ul className="mt-3 space-y-3">
          {active.map((user) => {
            const isSelf = user.id === admin.userId;
            return (
              <li
                key={user.id}
                className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {user.displayName}
                    {user.department ? (
                      <span className="ml-2 text-sm font-normal text-zinc-500">
                        {user.department}
                      </span>
                    ) : null}
                    {user.isPortalAdmin ? (
                      <span className="ml-2 rounded bg-zinc-900 px-1.5 py-0.5 text-[11px] text-white dark:bg-zinc-100 dark:text-zinc-900">
                        관리자
                      </span>
                    ) : null}
                    {isSelf ? <span className="ml-2 text-xs text-zinc-500">(나)</span> : null}
                  </span>
                  <span className="text-xs text-zinc-500">
                    마지막 로그인 {formatDateTime(user.lastLoginAt)} ·{" "}
                    <ProviderBadges providers={user.providers} />
                  </span>
                </div>

                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
                    정보 수정
                  </summary>
                  <form action={updateUserProfile} className="mt-3 space-y-3">
                    <input type="hidden" name="userId" value={user.id} />
                    <ProfileFields user={user} />
                    <button type="submit" className={`${BTN} ${BTN_PLAIN}`}>
                      저장
                    </button>
                  </form>
                </details>

                <div className="mt-3 flex flex-wrap items-start gap-2">
                  <form action={setPortalAdmin}>
                    <input type="hidden" name="userId" value={user.id} />
                    <input
                      type="hidden"
                      name="grant"
                      value={user.isPortalAdmin ? "false" : "true"}
                    />
                    {/*
                      자기 권한을 스스로 빼면 그 즉시 이 화면에서 튕겨 나간다.
                      서버 액션이 같은 조건으로 다시 막지만, 애초에 누를 수 없게
                      해두는 편이 친절하다.
                    */}
                    <button
                      type="submit"
                      disabled={user.isPortalAdmin && isSelf}
                      className={`${BTN} ${BTN_PLAIN}`}
                    >
                      {user.isPortalAdmin ? "관리자 해제" : "관리자 지정"}
                    </button>
                  </form>

                  {isSelf ? null : (
                    <details>
                      <summary
                        className={`${BTN} inline-block cursor-pointer list-none border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950`}
                      >
                        정지
                      </summary>
                      <form
                        action={suspendUser}
                        className="mt-2 flex flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="userId" value={user.id} />
                        <input
                          name="reason"
                          placeholder="정지 사유 (예: 퇴사)"
                          maxLength={100}
                          className={`${INPUT} max-w-xs`}
                        />
                        <button
                          type="submit"
                          className={`${BTN} bg-red-600 text-white hover:bg-red-500`}
                        >
                          정지 확정
                        </button>
                      </form>
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {suspended.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-sm font-semibold">
            정지됨 <span className="text-zinc-500">{suspended.length}</span>
          </h2>
          <ul className="mt-3 space-y-3">
            {suspended.map((user) => (
              <li
                key={user.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 p-5 opacity-70 dark:border-zinc-800"
              >
                <div>
                  <span className="font-medium line-through">{user.displayName}</span>
                  {user.suspendReason ? (
                    <span className="ml-2 text-sm text-zinc-500">{user.suspendReason}</span>
                  ) : null}
                </div>
                <form action={reactivateUser}>
                  <input type="hidden" name="userId" value={user.id} />
                  <button type="submit" className={`${BTN} ${BTN_PLAIN}`}>
                    정지 해제
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
