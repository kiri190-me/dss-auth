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
 * pg_dump를 부르는 길이 둘이다 — BACKUP_MODE로 고른다.
 *
 *   docker (기본)  도커에게 "DB 컨테이너 안의 pg_dump를 대신 돌려 달라"고
 *                  시킨다. 개발 PC에 PostgreSQL 클라이언트가 깔려 있지
 *                  않아도 되고, 서버와 정확히 같은 버전이 보장된다.
 *
 *   direct         DATABASE_URL로 DB에 직접 접속해서 뜬다. 이 스크립트가
 *                  **컨테이너 안에서 돌 때는 이쪽뿐이다** — 컨테이너 안에는
 *                  docker 명령이 없기 때문이다. NAS(Synology Docker) 운영이
 *                  여기 해당한다. 계측기 시스템의 백업이 처음부터 이 방식이다.
 *
 * ⚠️ 컨테이너에서 docker 모드를 쓰려고 /var/run/docker.sock을 물리지 말 것.
 *    소켓 접근은 사실상 호스트 root 권한이다 — 그 소켓으로 특권 컨테이너를
 *    띄우면 NAS 전체를 가져갈 수 있다. 하필 이 포털 컨테이너에 그것을 주면,
 *    인증 DB를 업무 DB와 따로 격리한 이유가 통째로 무너진다.
 *    direct 모드는 그 유혹을 없애려고 있는 것이다.
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

// direct 모드는 DATABASE_URL이 필요한데, 이 스크립트는 Next.js 밖에서 돌아
// .env.local을 자동으로 읽지 않는다. 이미 설정된 환경변수는 덮지 않으므로,
// 컨테이너에서 넘긴 값이 언제나 이긴다.
try {
  process.loadEnvFile(".env.local");
} catch {
  // 파일이 없어도 된다. 환경변수로 직접 넘기는 경우가 그렇다(NAS).
}

/** "docker"(기본) 또는 "direct". 머리말에 각각의 쓰임과 금기가 있다. */
const MODE = (process.env.BACKUP_MODE ?? "docker").trim().toLowerCase();

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

function dumpDatabase(dir: string): { file: string; restore: string } {
  // --clean --if-exists: 복원할 때 기존 객체를 먼저 지운다. 없으면 빈 DB에만
  // 복원할 수 있어, 정작 사고가 났을 때 한 단계가 더 늘어난다.
  // 두 모드가 **같은 덤프**를 만들도록 이 인자는 한 곳에만 둔다.
  const dumpArgs = ["--clean", "--if-exists"];
  const options = { encoding: "utf8" as const, maxBuffer: 512 * 1024 * 1024 };

  let sql: string;
  let name: string;
  let restore: string;

  if (MODE === "direct") {
    const raw = process.env.DATABASE_URL;
    if (!raw) {
      throw new Error(
        "BACKUP_MODE=direct 에는 DATABASE_URL이 필요합니다. .env.local에 두거나 환경변수로 넘기세요."
      );
    }
    const url = new URL(raw);
    name = url.pathname.replace(/^\//, "");
    const user = decodeURIComponent(url.username);
    const host = url.hostname;
    const port = url.port || "5432";

    // PG_BIN이 비어 있으면 PATH에서 찾는다. 컨테이너에서는 그쪽이 맞다.
    // ⚠️ 클라이언트 버전이 서버보다 낮으면 뜨다가 거절당한다. 이미지에는
    //    서버와 같은 major(17)의 postgresql-client를 넣어야 한다.
    const pgDump = join(
      process.env.PG_BIN ?? "",
      process.platform === "win32" ? "pg_dump.exe" : "pg_dump"
    );

    try {
      sql = execFileSync(
        pgDump,
        ["-h", host, "-p", port, "-U", user, "-d", name, ...dumpArgs],
        // 비밀번호는 명령줄이 아니라 환경변수로 넘긴다. 명령줄에 넣으면
        // 프로세스 목록에 그대로 보인다.
        { ...options, env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) } }
      );
    } catch (error) {
      // 개발 PC에는 대개 클라이언트가 깔려 있지 않다. 원인을 바로 알려 준다.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `pg_dump를 찾지 못했습니다(${pgDump}).\n` +
            `  · 개발 PC라면 BACKUP_MODE를 지우세요. 기본값 docker가 컨테이너 안의 것을 씁니다.\n` +
            `  · 클라이언트가 다른 곳에 있으면 PG_BIN에 그 bin 폴더를 넣으세요.\n` +
            `  · 컨테이너라면 이미지에 postgresql-client-17이 빠졌습니다.`
        );
      }
      throw error;
    }
    restore = `psql -h ${host} -p ${port} -U ${user} -d ${name} < ${name}.sql`;
  } else {
    name = DB_NAME;
    sql = execFileSync(
      "docker",
      ["exec", CONTAINER, "pg_dump", "-U", DB_USER, "-d", DB_NAME, ...dumpArgs],
      options
    );
    restore = `docker exec -i ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} < ${DB_NAME}.sql`;
  }

  if (!sql.includes("PostgreSQL database dump")) {
    throw new Error(
      MODE === "direct"
        ? "pg_dump 결과가 덤프처럼 보이지 않습니다. DATABASE_URL과 pg_dump 설치를 확인하세요."
        : "pg_dump 결과가 덤프처럼 보이지 않습니다. 컨테이너 이름과 DB 이름을 확인하세요."
    );
  }

  const file = join(dir, `${name}.sql`);
  writeFileSync(file, sql, "utf8");
  return { file, restore };
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
  // 여기서 검사한다. 모듈 최상단에서 던지면 아래 try/catch가 잡지 못해
  // 친절한 안내 대신 스택 트레이스가 그대로 나온다.
  if (MODE !== "docker" && MODE !== "direct") {
    throw new Error(
      `BACKUP_MODE는 docker 또는 direct여야 합니다(받은 값: ${MODE}).`
    );
  }

  const dir = join(OUT_ROOT, stamp());
  mkdirSync(dir, { recursive: true });

  console.log(`\n백업 위치: ${dir}`);
  // 어느 길로 떴는지 남긴다. 복원할 때 쓸 명령이 모드마다 다르기 때문이다.
  console.log(
    `방식: ${MODE}` +
      (MODE === "direct" ? "  (DB에 직접 접속)" : "  (도커에게 시킴)") +
      "\n"
  );

  const dump = dumpDatabase(dir);
  console.log(`  ✓ DB 덤프      ${dump.file}`);

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
  console.log(`    ${dump.restore}`);
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
