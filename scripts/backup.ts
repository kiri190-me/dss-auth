/**
 * 포털 백업 — DB와 서명 키.
 *
 * 왜 필요한가: 이 저장소에는 백업 수단이 하나도 없었다(A/S 시스템에는 정리
 * 3종과 첨부 백업이 있는 것과 대비된다). 그런데 이 포털이 잃으면 안 되는
 * 것을 둘이나 붙들고 있다.
 *
 *   DB    — 카카오 회원번호와 사원의 연결. 잃으면 전 직원이 다시 로그인해
 *           승인 대기부터 시작하고, 각 시스템의 sso_subject 연결도 끊긴다.
 *   서명 키 — 잃으면 새 키로 갈아야 하고, 그 순간 발급된 통행증이 전부
 *           무효가 된다.
 *
 * ⚠️ 둘을 한 곳에 두지 않는다.
 *
 * 그래서 키 백업은 기본 동작이 아니라 --keys 를 줄 때만 한다. DB 덤프와 키를
 * 같은 폴더에 나란히 두면, 그 폴더 하나가 새는 순간 "남의 신원으로 로그인할
 * 수 있는 키"와 "누가 있는지 적힌 명단"을 함께 잃는다. 키는 따로, 되도록
 * 오프라인에 둔다.
 *
 * 사용법:
 *   npm run backup                → DB만
 *   npm run backup -- --keys      → 서명 키도 (다른 곳에 보관할 것)
 *   npm run backup -- --out D:\백업
 *
 * pg_dump는 DB 컨테이너 안의 것을 쓴다. 개발 PC에 PostgreSQL 클라이언트가
 * 깔려 있지 않아도 되고, 서버와 정확히 같은 버전이 보장된다.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}
const includeKeys = args.includes("--keys");

const CONTAINER = process.env.BACKUP_DB_CONTAINER ?? "dss-auth-postgres-dev";
const DB_USER = process.env.BACKUP_DB_USER ?? "dss_auth_app";
const DB_NAME = process.env.BACKUP_DB_NAME ?? "dss_auth_dev";
const KEYS_DIR = process.env.AUTH_KEYS_DIR ?? "./keys";
const OUT_ROOT = arg("out") ?? process.env.BACKUP_DIR ?? "./backups";

/** 파일 이름에 쓸 수 있는 형태로. 정렬하면 시간순이 된다. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function dumpDatabase(dir: string): string {
  // --clean --if-exists: 복원할 때 기존 객체를 먼저 지운다. 없으면 빈 DB에만
  // 복원할 수 있어, 정작 사고가 났을 때 한 단계가 더 늘어난다.
  const sql = execFileSync(
    "docker",
    ["exec", CONTAINER, "pg_dump", "-U", DB_USER, "-d", DB_NAME, "--clean", "--if-exists"],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }
  );

  if (!sql.includes("PostgreSQL database dump")) {
    throw new Error("pg_dump 결과가 덤프처럼 보이지 않습니다. 컨테이너 이름과 DB 이름을 확인하세요.");
  }

  const file = join(dir, `${DB_NAME}.sql`);
  writeFileSync(file, sql, "utf8");
  return file;
}

function copyKeys(dir: string): string[] {
  const target = join(dir, "keys");
  mkdirSync(target, { recursive: true });

  const copied: string[] = [];
  for (const name of readdirSync(KEYS_DIR)) {
    if (!name.endsWith(".json")) continue;
    copyFileSync(join(KEYS_DIR, name), join(target, name));
    copied.push(name);
  }
  return copied;
}

function main() {
  const dir = join(OUT_ROOT, stamp());
  mkdirSync(dir, { recursive: true });

  console.log(`\n백업 위치: ${dir}\n`);

  const dumpFile = dumpDatabase(dir);
  console.log(`  ✓ DB 덤프      ${dumpFile}`);

  if (includeKeys) {
    const copied = copyKeys(dir);
    console.log(`  ✓ 서명 키      ${copied.length}개 (${copied.join(", ")})`);
    console.log("");
    console.log("─".repeat(64));
    console.log("  ⚠ 서명 키가 이 폴더에 함께 들어 있습니다.");
    console.log("    키 파일 하나면 누구든 통행증을 위조해 아무 사람으로든");
    console.log("    모든 사내 시스템에 들어갈 수 있습니다.");
    console.log("    DB 덤프와 **다른 장소**로 옮기고, 이 폴더에서는 지우세요.");
    console.log("─".repeat(64));
  } else {
    console.log("");
    console.log("  서명 키는 받지 않았습니다. 키까지 받으려면 --keys 를 주세요");
    console.log("  (DB와 다른 장소에 보관해야 합니다).");
  }

  console.log("");
  console.log("  복원:");
  console.log(`    docker exec -i ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} < ${DB_NAME}.sql`);
  console.log("");
  console.log("  ⚠ 복원을 한 번 실제로 해보기 전까지는 백업이 있다고 하지 않는 편이 안전합니다.");
  console.log("");
}

try {
  main();
} catch (error) {
  console.error("\n백업 실패:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
