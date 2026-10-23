/**
 * ============================================================================
 * 결재 알림 메일 보내기 — NAS 작업 스케줄러가 부르는 자리
 * ============================================================================
 * 새 결재 요청이 생기면 그 결재를 해야 할 사람에게 메일 한 통을 보낸다. 누구에게
 * 무엇을 보낼지는 src/lib/approvals/ 가 정하고, 이 파일은 **부르고 찍고 끝내는**
 * 일만 한다.
 *
 *   npm run notify:approvals            실제로 보낸다
 *   npm run notify:approvals -- --dry-run   보내지도 적지도 않고 셈만 한다
 *
 * 🔴 **처음 켤 때는 `--dry-run` 을 먼저 돌려 보라.** 「몇 명에게 몇 건이 갈
 * 뻔했는가」가 그대로 찍힌다. 메일은 한 번 나가면 회수할 수 없다.
 *
 * ── NAS 에서 ───────────────────────────────────────────────────────────────
 * 계측기 교정 알림(dss-deploy/nas/jobs/notify-daily.sh)과 같은 모양으로 돈다:
 * DSM 작업 스케줄러가 root 로 하루 한 번 부르고, 그 스크립트가 도구 컨테이너를
 * `run --rm` 으로 잠깐 띄운다(상시 서비스가 아니라 메모리 예산을 건드리지 않는다).
 *
 *   docker compose … --profile tools run --rm tools-auth npm run notify:approvals
 *
 * ⚠️ 도구 이미지에는 `.env.local` 이 없다. 그래서 package.json 의 이 스크립트는
 *    `--env-file-if-exists` 로 적혀 있다 — 개발 PC 에서는 파일을 읽고, 컨테이너
 *    에서는 없는 파일을 **조용히 지나가** 환경변수를 그대로 쓴다. (다른 스크립트
 *    들은 아직 `--env-file` 이라 컨테이너에서 그 줄에 죽는다. Dockerfile 의 tools
 *    스테이지 주석에 적힌 그 자리다.)
 *
 * 🔴 **`--conditions=react-server` 가 필요하다.** 이 스크립트가 부르는 코드가
 *    Next 서버 전용 모듈("server-only")을 거쳐 간다 — 그 조건이 없으면 import 에서
 *    멈춘다(scripts/check-notifications.ts 와 같다).
 * ============================================================================
 */
import { pgClient } from "../src/lib/db/connection";
import { runApprovalMails } from "../src/lib/approvals/service";
import { approvalMailRunFailed, describeApprovalMailRun } from "../src/lib/approvals/run";

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("─".repeat(64));
  console.log(`  DSS 결재 알림 메일 · ${new Date().toLocaleString("ko-KR")}`);
  console.log("─".repeat(64));

  const report = await runApprovalMails({ dryRun });
  for (const line of describeApprovalMailRun(report)) console.log(line);

  console.log("─".repeat(64));

  // 🔴 「못 물어본 시스템」 하나로는 실패가 아니다 — 그 기준은 run.ts 에 있다.
  //    종료 코드가 곧 작업 스케줄러의 빨강이고, 늘 빨가면 아무도 보지 않는다.
  if (approvalMailRunFailed(report)) process.exitCode = 1;
}

main()
  .catch((error) => {
    // 여기까지 올라오는 것은 DB 조회나 설정 읽기가 통째로 깨진 경우다.
    // 사람마다의 실패는 report 안에 담겨 위에서 찍힌다.
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
