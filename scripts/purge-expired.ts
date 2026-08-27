/**
 * 다 쓴 행 정리.
 *
 * 왜 필요한가: 지금까지 지우는 코드가 없어서 만료된 인가 코드·토큰·세션이
 * 영원히 쌓였다. 개발 몇 시간 만에 인가 코드 20건 중 20건이 만료 상태였고,
 * 감사 로그의 "보관 3년"은 스키마 주석에만 있어 실제로는 영구 보관이었다 —
 * source_ip와 user_agent를 의도보다 오래 갖고 있게 된다.
 *
 * 얼마나 남길지와 그 근거는 src/lib/db/retention.ts에 있다. 이 파일은
 * 그 판정을 실행하기만 한다.
 *
 * 사용법:
 *   npm run db:purge -- --dry-run   → 지우지 않고 몇 건인지만 센다
 *   npm run db:purge                → 실제로 지운다
 *
 * NAS에서는 작업 스케줄러가 하루 한 번 부르게 한다. 앱 안의 타이머로 두지
 * 않는 이유: 프로세스가 여럿이면 동시에 돌고, 배포할 때마다 시계가
 * 초기화되며, 무엇보다 언제 돌았는지 알 수 없다. A/S 시스템의 purge:*
 * 스크립트들과 같은 판단이다.
 */
// 환경변수는 node --env-file=.env.local 로 주입한다(package.json 참조).
import { and, isNotNull, lt, or, sql } from "drizzle-orm";
import { db, pgClient } from "../src/lib/db/connection";
import { retentionCutoffs } from "../src/lib/db/retention";
import {
  accessTokens,
  auditLogs,
  authorizationCodes,
  ssoSessions,
} from "../src/lib/db/schema";

const dryRun = process.argv.includes("--dry-run");

/**
 * 기준 시각을 한 번만 구해 네 표에 똑같이 쓴다. 표마다 now()를 다시 부르면
 * 한 번의 실행이 여러 기준 시각을 갖게 되어, 경계에 걸친 행이 이번에
 * 지워졌는지 다음에 지워질지 설명할 수 없게 된다.
 */
const now = new Date();
const cutoff = retentionCutoffs(now);

type Sweep = {
  label: string;
  /** 남기는 기간을 사람 말로. 출력에 그대로 쓴다. */
  keeps: string;
  count(): Promise<number>;
  purge(): Promise<number>;
};

const sweeps: Sweep[] = [
  {
    label: "authorization_codes",
    keeps: "만료 후 7일",
    count: async () => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(authorizationCodes)
        .where(lt(authorizationCodes.expiresAt, cutoff.authorizationCodes));
      return row?.n ?? 0;
    },
    purge: async () => {
      const deleted = await db
        .delete(authorizationCodes)
        .where(lt(authorizationCodes.expiresAt, cutoff.authorizationCodes))
        .returning({ id: authorizationCodes.codeHash });
      return deleted.length;
    },
  },
  {
    label: "access_tokens",
    keeps: "만료 후 7일",
    count: async () => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(accessTokens)
        .where(lt(accessTokens.expiresAt, cutoff.accessTokens));
      return row?.n ?? 0;
    },
    purge: async () => {
      const deleted = await db
        .delete(accessTokens)
        .where(lt(accessTokens.expiresAt, cutoff.accessTokens))
        .returning({ id: accessTokens.tokenHash });
      return deleted.length;
    },
  },
  {
    label: "sso_sessions",
    keeps: "만료·폐기 후 30일",
    // 만료된 것과 손으로 폐기한 것 둘 다 대상이다. 폐기된 세션은 만료 시각이
    // 아직 미래일 수 있으므로(12시간 전에 로그아웃한 경우) 두 조건을 함께 본다.
    count: async () => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(ssoSessions)
        .where(
          or(
            lt(ssoSessions.expiresAt, cutoff.ssoSessions),
            and(
              isNotNull(ssoSessions.revokedAt),
              lt(ssoSessions.revokedAt, cutoff.ssoSessions)
            )
          )
        );
      return row?.n ?? 0;
    },
    purge: async () => {
      const deleted = await db
        .delete(ssoSessions)
        .where(
          or(
            lt(ssoSessions.expiresAt, cutoff.ssoSessions),
            and(
              isNotNull(ssoSessions.revokedAt),
              lt(ssoSessions.revokedAt, cutoff.ssoSessions)
            )
          )
        )
        .returning({ id: ssoSessions.id });
      return deleted.length;
    },
  },
  {
    label: "audit_logs",
    keeps: "3년",
    count: async () => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(lt(auditLogs.createdAt, cutoff.auditLogs));
      return row?.n ?? 0;
    },
    purge: async () => {
      const deleted = await db
        .delete(auditLogs)
        .where(lt(auditLogs.createdAt, cutoff.auditLogs))
        .returning({ id: auditLogs.id });
      return deleted.length;
    },
  },
];

async function main() {
  console.log(
    dryRun
      ? "\n다 쓴 행 정리 — 세어 보기만 합니다(지우지 않습니다).\n"
      : "\n다 쓴 행 정리\n"
  );

  let total = 0;
  for (const sweep of sweeps) {
    const n = dryRun ? await sweep.count() : await sweep.purge();
    total += n;
    const verb = dryRun ? "지울 수 있음" : "지웠습니다";
    console.log(`  ${sweep.label.padEnd(21)} ${String(n).padStart(6)}건 ${verb}  (${sweep.keeps})`);
  }

  console.log("");
  if (total === 0) {
    console.log("  정리할 것이 없습니다.");
  } else if (dryRun) {
    console.log(`  합계 ${total}건. 실제로 지우려면 --dry-run 없이 실행하세요.`);
  } else {
    console.log(`  합계 ${total}건을 지웠습니다.`);
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
