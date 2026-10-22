/**
 * 도구 이미지(dss-auth-tools)가 설 수 있는 모양인지 글자로 재는 시험.
 *
 * 왜 이런 시험이 있는가: 이 자리의 결함은 **오류를 내지 않는다.**
 *
 *   · .dockerignore 가 drizzle/ 을 막으면 Dockerfile 의 `COPY drizzle ./drizzle`
 *     이 빈 폴더를 담고, 운영에서 db:migrate 가 「적용할 것 없음」으로 조용히
 *     끝난다. 그 다음에 깨지는 것은 마이그레이션이 아니라 **앱**이고, 그때는
 *     원인에서 멀어져 있다.
 *   · tools 스테이지를 runner 뒤로 옮기면 `--target` 없이 구운 이미지가 앱이
 *     아니라 도구가 된다. 태그는 같아서 눈으로는 구별이 안 된다.
 *   · 이미지에 DATABASE_URL 을 구워 두면 비밀번호가 tar 파일로 돌아다닌다.
 *
 * 셋 다 빌드는 성공하고 시험도 (이 파일이 없으면) 통과한다. 그래서 글자로 잰다.
 *
 * ⚠️ 이 시험은 **파일의 글자**를 잴 뿐 이미지를 굽지 않는다. 실제로 8개가
 *    들어갔는지는 구운 뒤 사람이 센다:
 *      docker run --rm dss-auth-tools:1 sh -c 'ls /app/drizzle/*.sql | wc -l'
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const repoRoot = new URL("../../", import.meta.url);

const dockerfile = readFileSync(new URL("Dockerfile", repoRoot), "utf8");
const dockerignore = readFileSync(new URL(".dockerignore", repoRoot), "utf8");

/**
 * .dockerignore 의 "막는" 줄들. 주석·빈 줄은 빼고, `!` 로 시작하는 되살리는
 * 줄도 뺀다(그것은 막는 것이 아니다). 앞뒤의 `./` `/` `/` 는 떼어 비교하기
 * 쉽게 만든다.
 */
function blockingPatterns(): string[] {
  return dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => line.replace(/^\.?\//, "").replace(/\/+$/, ""));
}

/** Dockerfile 에서 `FROM … AS <이름>` 으로 선언된 스테이지 이름을 적힌 차례대로. */
function stageNames(): string[] {
  return [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1]);
}

/** 스테이지 하나의 본문(다음 FROM 전까지). 없으면 빈 문자열. */
function stageBody(name: string): string {
  const lines = dockerfile.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`, "i").test(line.trim())
  );
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^FROM\s/i.test(line.trim()));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** 주석을 뺀 본문 — `# COPY drizzle …` 같은 주석에 속지 않으려고. */
function withoutComments(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

test("tools 스테이지가 있다 — 운영에서 db:migrate 를 부를 유일한 자리다", () => {
  assert.ok(
    stageNames().includes("tools"),
    "Dockerfile 에 `FROM … AS tools` 가 있어야 한다. 운영 이미지(runner)에는 " +
      "drizzle-kit 이 없어서(devDependency) 그 안에서는 마이그레이션을 돌릴 수 없다"
  );
});

test("tools 는 runner 보다 **앞**에 있다 — 마지막 스테이지가 기본 빌드 대상이다", () => {
  const names = stageNames();
  const [tools, runner] = [names.indexOf("tools"), names.indexOf("runner")];
  assert.ok(runner !== -1, "Dockerfile 에 `FROM … AS runner` 가 있어야 한다");
  assert.ok(tools !== -1, "Dockerfile 에 `FROM … AS tools` 가 있어야 한다");
  assert.ok(
    tools < runner,
    "tools 를 runner 뒤로 옮기면 `--target` 없이 구운 이미지가 앱이 아니라 도구가 " +
      "된다 — 그 이미지는 `node server.js` 를 모르는데 태그는 같아 눈으로 구별이 안 된다"
  );
});

test("tools 가 drizzle/ 을 담는다 — 담지 않으면 돌릴 .sql 이 없다", () => {
  const body = withoutComments(stageBody("tools"));
  assert.match(
    body,
    /^COPY\s+(--\S+\s+)*drizzle\s+\.\/drizzle\s*$/im,
    "tools 스테이지에 `COPY drizzle ./drizzle` 이 있어야 한다. A/S 와 달리 포털은 " +
      "볼륨이 아니라 이미지에 굽는다(drizzle/ 이 292KB 뿐이고, 볼륨으로 하면 " +
      "배포 때마다 사람이 파일을 올려야 하며 빠뜨려도 오류가 안 난다)"
  );
});

test("tools 가 drizzle.config.ts 와 src 도 담는다 — 설정이 가리키는 곳이다", () => {
  // 이 스테이지는 builder 와 달리 `COPY . .` 가 아니라 폴더를 골라 담는다.
  // drizzle.config.ts 의 schema 가 ./src/lib/db/schema/index.ts 를 가리키므로
  // 둘 중 하나라도 빠지면 「Cannot find module」 로 죽는다.
  const body = withoutComments(stageBody("tools"));
  assert.match(body, /\bdrizzle\.config\.ts\b/, "tools 가 drizzle.config.ts 를 담아야 한다");
  assert.match(body, /^COPY\s+(--\S+\s+)*src\s+\.\/src\s*$/im, "tools 가 src 를 담아야 한다");
});

test("tools 에 DATABASE_URL 을 굽지 않는다 — 비밀번호가 tar 로 돌아다닌다", () => {
  // builder 에는 가짜 값이 있어야 맞다(`next build` 가 서버 모듈을 불러서 검사한다).
  // 그 값은 별도 FROM 이라 tools 로 넘어오지 않는다. 여기는 **진짜** 주소를
  // 받아야 하는 자리이므로, 굽는 순간 운영 비밀번호가 이미지에 박힌다.
  const body = withoutComments(stageBody("tools"));
  assert.doesNotMatch(
    body,
    /^\s*ENV\s+[^\n]*DATABASE_URL/im,
    "tools 스테이지에 ENV DATABASE_URL 을 두지 않는다. 운영에서는 compose 가 " +
      "환경변수로 넣는다 — 없으면 drizzle.config.ts 가 바로 던지고, 그게 맞는 동작이다"
  );
});

test(".dockerignore 가 drizzle/ 을 막지 않는다 — 막으면 0건으로 조용히 끝난다", () => {
  // ⚠️ 이 검사는 .dockerignore 문법을 전부 흉내 내지 않는다. 현실에서 이 폴더를
  //    실수로 막는 꼴들만 본다 — `drizzle` · `drizzle/` · `drizzle/**` ·
  //    `**/drizzle` · 그리고 전부를 막는 `*` · `**`.
  const forbidden = new Set(["drizzle", "drizzle/*", "drizzle/**", "**/drizzle", "*", "**"]);
  for (const pattern of blockingPatterns()) {
    assert.ok(
      !forbidden.has(pattern) && !pattern.startsWith("drizzle/"),
      `.dockerignore 의 "${pattern}" 이 drizzle/ 을 막는다. 그러면 ` +
        "`COPY drizzle ./drizzle` 이 빈 폴더를 담고, 운영에서 db:migrate 가 " +
        "오류 없이 「적용할 것 없음」으로 끝난다"
    );
  }
});

test(".dockerignore 가 서명 개인키와 .env* 는 계속 막는다", () => {
  // 위 시험을 통과시키려고 .dockerignore 를 헐겁게 고치는 길을 막아 둔다.
  // keys/ 하나면 누구든 통행증을 위조해 아무 사람으로든 모든 사내 시스템에
  // 들어갈 수 있다(.dockerignore 머리말).
  const patterns = blockingPatterns();
  assert.ok(patterns.includes("keys"), ".dockerignore 가 keys/ 를 막아야 한다");
  assert.ok(patterns.includes(".env*"), ".dockerignore 가 .env* 를 막아야 한다");
});

test("drizzle/ 의 .sql 이 모두 _journal.json 에 올라 있다 — 목록에 없으면 안 돈다", () => {
  // drizzle-kit 은 폴더를 훑지 않고 meta/_journal.json 의 목록만 돌린다.
  // 손으로 .sql 을 넣으면 파일은 이미지에 들어가는데 적용은 안 된다 —
  // 이것도 오류가 아니라 「0건」으로 끝나는 자리다.
  const sqlFiles = readdirSync(new URL("drizzle/", repoRoot))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const journal = JSON.parse(
    readFileSync(new URL("drizzle/meta/_journal.json", repoRoot), "utf8")
  ) as { entries: { tag: string }[] };
  const listed = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));

  assert.ok(sqlFiles.length > 0, "drizzle/ 에 .sql 이 하나도 없다");
  for (const file of sqlFiles) {
    assert.ok(
      listed.has(file),
      `${file} 이 drizzle/meta/_journal.json 에 없다 — 이미지에는 들어가지만 ` +
        "db:migrate 가 돌리지 않는다. npm run db:generate 로 만든 것이 맞는지 본다"
    );
  }
  assert.equal(
    journal.entries.length,
    sqlFiles.length,
    "_journal.json 의 항목 수와 drizzle/ 의 .sql 수가 같아야 한다"
  );
});
