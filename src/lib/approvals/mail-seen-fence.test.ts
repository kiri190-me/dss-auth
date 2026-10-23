import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * ============================================================================
 * 🔴 **밤에 도는 메일 작업은 `seen_at` 을 건드리지 않는다** — 구조로 못 박는다
 * ============================================================================
 * `/apps` 승인함 타일의 빨간 점은 `approval_inbox_views.seen_at` 하나로 꺼진다
 * (approvals/tile-dot.ts). 그 값을 **사람이 아닌 작업이** 밀어 버리면 어떻게
 * 되는가:
 *
 *   밤 2시에 메일 작업이 세 시스템에 결재를 묻는다 → 그 길에서 seen_at 이
 *   갱신된다 → 아침에 출근한 사람의 타일에는 **점이 없다** → 새 결재가 와 있는데
 *   아무도 모른다.
 *
 * 🔴 **이 사고는 오류를 내지 않는다.** 메일은 멀쩡히 가고, 승인함에도 결재가 잘
 * 뜬다. 점 하나만 조용히 안 뜨므로 신고도 안 들어온다. 그래서 「조심하자」로는
 * 못 지키고, **닿는 길이 아예 없다**를 시험이 재야 한다.
 *
 * ── 어떻게 재는가 ─────────────────────────────────────────────────────────
 * 들머리 파일에서 시작해 `import` 를 **따라가며** 닿는 파일을 모은다. 글자만
 * 찾지 않는 까닭: 🔴 주석에 「seen_at 을 건드리지 않는다」라고 적는 순간 글자
 * 검사는 뒤집힌다. 그래서 **주석을 먼저 걷어 내고**, 남은 `import` 만 따라간다.
 *
 * 🔵 걸어 보는 자(尺)가 고장 나면 이 시험은 **언제나 통과**한다(닿는 파일이 0개
 * 여도 「안 닿는다」가 참이다). 그래서 아래 첫 시험이 **닿아야 하는 쪽**을
 * 먼저 잰다 — 승인함 통로의 라우트에서는 그 모듈에 **반드시** 닿는다.
 * ============================================================================
 */

/** 저장소 뿌리. 🔵 cwd 에 기대지 않는다 — 어디서 불러도 같은 자리를 본다. */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const file = (relative: string) => path.join(REPO, relative);

/** 🔴 `seen_at` 에 **쓰는** 유일한 모듈. */
const SEEN_WRITER = file("src/lib/db/mutations/approval-inbox-views.ts");
/** `seen_at` 을 **읽는** 모듈. 점을 재는 쪽은 여기까지만 닿아야 한다. */
const SEEN_READER = file("src/lib/db/queries/approval-inbox-views.ts");

/** 메일 작업의 들머리 둘 — 배선과 그것을 부르는 작업 스크립트. */
const MAIL_ENTRIES = [
  file("src/lib/approvals/service.ts"),
  file("scripts/send-approval-mails.ts"),
];

/**
 * 주석을 걷어 낸다.
 *
 * 🔵 `[^:]` 를 앞에 둬서 `https://` 를 줄 끝 주석으로 오해하지 않게 한다. 설령
 * 오해하더라도 이 함수의 쓰임(=import 찾기)에는 해가 없지만, 다음 사람이 이
 * 함수를 다른 데 가져다 쓸 때를 생각해 맞게 적어 둔다.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 한 파일이 **실제로** 들여오는 것들(주석 속의 글자는 빠진다). */
function importsOf(source: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComments(source))) !== null) {
    specs.push(match[1]);
  }
  return specs;
}

/**
 * 들여온 이름을 파일 자리로 푼다. 🔵 저장소 바깥(`next` · `server-only` ·
 * `drizzle-orm`)은 `null` 이다 — 따라갈 까닭이 없다.
 */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(REPO, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;

  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 들머리에서 import 를 따라가 **닿는 파일 전부.** */
function reachableFrom(entry: string): Set<string> {
  assert.ok(existsSync(entry), `들머리가 없다: ${entry}`);

  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);

    for (const spec of importsOf(readFileSync(current, "utf8"))) {
      const resolved = resolveSpec(spec, current);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return seen;
}

// ─────────────────────────────── ① 자(尺)가 실제로 무는가

test("🔴 승인함 통로의 라우트에서는 seen_at 을 쓰는 모듈에 **닿는다**", () => {
  // 🔴 이 시험이 먼저 있어야 아래 「안 닿는다」가 뜻을 갖는다. 걷는 함수가
  //    고장 나 아무 데도 못 닿으면 아래는 전부 공짜로 통과한다.
  const reached = reachableFrom(file("src/app/api/integration/approvals/route.ts"));

  assert.ok(reached.has(SEEN_WRITER), "승인함을 열어도 seen_at 이 갱신되지 않는다");
  assert.ok(
    reached.has(file("src/lib/approvals/screen-request.ts")),
    "판정 모듈에도 못 닿았다 — 걷는 함수가 고장 났다"
  );
  assert.ok(reached.size > 10, `닿은 파일이 ${reached.size}개뿐이다 — 너무 적다`);
});

// ─────────────────────────────── ② 메일 길에는 닿지 않는다

test("🔴 메일 작업에서는 seen_at 을 쓰는 모듈에 **닿지 않는다**", () => {
  for (const entry of MAIL_ENTRIES) {
    const reached = reachableFrom(entry);

    // 표본이 비지 않았는지 먼저 본다 — 메일 길의 알맹이에 실제로 닿았는가.
    for (const must of [
      "src/lib/approvals/run.ts",
      "src/lib/approvals/plan.ts",
      "src/lib/approvals/inbox.ts",
      "src/lib/approvals/mail-message.ts",
    ]) {
      assert.ok(reached.has(file(must)), `${entry} 에서 ${must} 에 못 닿았다`);
    }

    assert.equal(
      reached.has(SEEN_WRITER),
      false,
      `${entry} 가 seen_at 을 쓰는 모듈에 닿는다 — 아침마다 점이 사라진다`
    );
    assert.equal(
      reached.has(SEEN_READER),
      false,
      `${entry} 가 seen_at 을 읽는다 — 메일은 그 값을 볼 까닭이 없다`
    );
  }
});

test("🔵 메일 길이 표(스키마)에 닿는 것은 괜찮다 — 쓰는 코드가 아니다", () => {
  // `@/lib/db/schema` 는 표를 모아 내보내는 자리라 메일 쪽 조회들이 자연히
  // 거쳐 간다. 🔴 여기까지 막으려고 시험을 조이면 다음 사람이 **멀쩡한 조회**를
  // 고치게 된다. 막아야 하는 것은 「쓰는 코드」 하나다.
  const reached = reachableFrom(file("src/lib/approvals/service.ts"));
  assert.ok(reached.has(file("src/lib/db/schema/index.ts")));
  assert.equal(reached.has(SEEN_WRITER), false);
});

// ─────────────────────────────── ③ 점을 재는 길은 읽기만 한다

test("🔴 타일의 점을 재는 길은 seen_at 을 **읽기만** 한다", () => {
  // 재는 길에서 갱신하면 **`/apps` 를 여는 것만으로 점이 꺼져** 점이 영영 안 뜬다.
  const reached = reachableFrom(file("src/lib/approvals/screen-service.ts"));

  assert.ok(reached.has(SEEN_READER), "읽지도 않는다 — 점을 잴 기준이 없다");
  assert.ok(reached.has(file("src/lib/approvals/tile-dot.ts")), "판정 모듈에 못 닿았다");
  assert.equal(reached.has(SEEN_WRITER), false, "타일을 그리면서 seen_at 을 갱신한다");
});

// ─────────────────────────────── ④ 쓰는 쪽은 한 자리뿐이다

/** `src` 와 `scripts` 아래의 모든 소스 파일. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) found.push(full);
    }
  };
  walk(file("src"));
  walk(file("scripts"));
  return found;
}

test("🔴 seen_at 을 쓰는 모듈을 들여오는 곳은 승인함 라우트 **하나뿐**이다", () => {
  const files = sourceFiles();
  assert.ok(files.length > 50, `소스를 ${files.length}개밖에 못 읽었다 — 표본이 비었다`);

  const importers = files.filter((candidate) => {
    if (candidate === SEEN_WRITER) return false;
    return importsOf(readFileSync(candidate, "utf8")).some(
      (spec) => resolveSpec(spec, candidate) === SEEN_WRITER
    );
  });

  assert.deepEqual(
    importers.map((row) => path.relative(REPO, row).split(path.sep).join("/")),
    ["src/app/api/integration/approvals/route.ts"]
  );
});
