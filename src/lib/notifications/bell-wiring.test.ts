import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { NotificationBell, type NotificationBellItem } from "@dss/ui";

/**
 * ============================================================================
 * 🔴 포털 제 화면의 종이 **실제로 이어져 있는가** (2026-11-18)
 * ============================================================================
 * 사용자 요구는 한 줄이었다: 「포털 화면에도 종 알람이 뜨도록」. 모으는 일도
 * 권한 거르기도 이미 다 있었고(service.ts), 이번에 더한 것은 **화면 한 장과
 * 서버 액션 둘**뿐이다. 그래서 여기서 재는 것도 「계산이 맞는가」가 아니라
 * **배선이 끊기지 않았는가**다.
 *
 * ── 🔴 끊겨도 아무 소리가 안 나는 자리 다섯 ────────────────────────────────
 *  1. **CSS 한 줄** — 빠뜨리면 tsc 도 lint 도 조용히 통과하고 화면에서 종의
 *     생김새만 통째로 빠진다. 눈으로만 드러나는 함정이라 여기서 못 박는다.
 *  2. **머리말이 기다리지 않는다** — `await` 로 바꿔도 화면은 똑같이 뜬다.
 *     느려질 뿐이라 아무 시험도 안 깨지고 아무도 모른다.
 *  3. **사람은 세션에서만** — 인자로 받게 고쳐도 모든 시험이 그대로 통과한다.
 *     드러나는 모양은 「남의 알림을 지울 수 있다」 하나뿐이다.
 *  4. **✕ 가 그려진다** — `onDismiss` 를 안 넘기면 단추가 **아예 안 생긴다**
 *     (@dss/ui 의 규약). 오류가 아니라 「없음」이라 신고도 안 들어온다.
 *  5. **타일 빨간 점이 그대로다** — 종과 점은 역할이 다르고 공존한다
 *     (2026-11-18 사용자 결정). 점을 건드리면 여기서 걸린다.
 *
 * ── 왜 파일의 글자를 읽는가 ────────────────────────────────────────────────
 * 화면과 서버 액션은 실제로 불러 볼 수 없다(세션·쿠키·DB·요청 맥락이 있어야
 * 한다. 그리고 그 파일들은 `server-only` 사슬에 걸려 있어 node 시험이 아예
 * 가져오지 못한다 — session/sso-session.ts·service.ts 가 그렇다). 그래서 그
 * 자리들은 **구조**를 못 박고, 묶음이 실제로 그리는 것(빈 종·✕)은 **불러
 * 본다.**
 *
 * 🔴 값은 전부 가짜다 — 사람 이름도 고객사도 실제 건 번호도 들어 있지 않다.
 * ============================================================================
 */

const ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.resolve(ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/**
 * 주석을 걷어 낸 글자.
 *
 * 🔴 **걷어 내지 않으면 아래 시험들이 주석 때문에 통과한다.** 이 조각의
 * 주석에는 `@dss/ui/notification-bell.css` 도 `onDismiss` 도 `client_secret` 도
 * 적혀 있다(까닭을 적은 글이다). 재야 하는 것은 **도는 코드**다.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const appsPage = withoutComments(read("src/app/apps/page.tsx"));
const rootLayout = withoutComments(read("src/app/layout.tsx"));
const bellAction = withoutComments(read("src/lib/server/actions/notification-bell.ts"));
/**
 * 🔴 **tsconfig 만 주석을 안 걷어 낸다.** 걷으면 파일이 망가진다 — 이 파일에는
 * `"@/*"` 와 `"**\/*.ts"` 가 들어 있어서, 블록 주석을 찾는 규칙이 앞의 `/*` 와
 * 뒤의 `*\/` 를 한 쌍으로 읽고 **그 사이의 별칭 전부를 지워 버린다.** 실제로
 * 한 번 그렇게 깨졌다. 여기서 재는 것은 `"…css": [` 라는 **글자 그대로의
 * 열쇠**라 산문 주석이 우연히 맞힐 모양이 아니다.
 */
const tsconfig = read("tsconfig.json");
const merge = withoutComments(read("src/lib/notifications/merge.ts"));

/* ── 1. 🔴 CSS 를 실제로 불러온다 ─────────────────────────────────────── */

test("🔴 종의 생김새를 최상위 layout 이 한 번 부른다", () => {
  // 🔴 이 줄이 없으면 tsc 도 lint 도 그대로 통과한다(타입이 없는 CSS 다).
  //    드러나는 모양은 「종이 글자 뭉치로 보인다」 하나뿐이다.
  assert.match(rootLayout, /^import "@dss\/ui\/notification-bell\.css";$/m);
});

test("🔴 경로 별칭이 있어야 번들러가 그 파일을 찾는다", () => {
  assert.match(tsconfig, /"@dss\/ui\/notification-bell\.css": \[/);
  assert.match(tsconfig, /vendor\/dss-ui\/src\/notification-bell\/notification-bell\.css/);
});

test("🔴 별칭이 가리키는 파일이 서브모듈에 실제로 있다 — 포인터가 낡으면 여기서 걸린다", () => {
  const css = read("vendor/dss-ui/src/notification-bell/notification-bell.css");
  // 펼친 목록이 **오른쪽에 붙어 왼쪽으로** 펼쳐진다 — 종을 줄의 맨 오른쪽 끝에
  // 두는 판단(아래 시험)의 근거다.
  const listRule = css.match(/\.dss-bell__list \{([\s\S]*?)\n\}/);
  assert.ok(listRule, "펼친 목록 규칙을 찾지 못했다");
  assert.match(listRule[1], /position: absolute;/);
  assert.match(listRule[1], /right: 0;/, "왼쪽에 붙으면 종을 맨 끝에 둘 까닭이 사라진다");
});

test("메뉴바 CSS 는 부르지 않는다 — 포털은 그 조각을 안 쓴다", () => {
  // 🔵 조각마다 CSS 한 장이다. 안 쓰는 것을 부르면 로그인 화면까지 따라간다.
  assert.equal(
    rootLayout.includes("@dss/ui/styles.css"),
    false,
    "쓰지 않는 메뉴바 CSS 를 부른다"
  );
});

/* ── 2. 🔴 머리말이 기다리지 않는다 ───────────────────────────────────── */

test("🔴 종은 <Suspense> 로 흘려 넣는다 — 머리말에서 기다리지 않는다", () => {
  // 이 한 줄이 깨지면 포털 **첫 화면 전체**가 남의 서버 사정만큼 늦어진다
  // (각 시스템에 HTTP 왕복이고, 캐시가 비면 1.5초다).
  assert.match(appsPage, /<Suspense fallback=\{null\}>\s*<HeaderBell feed=\{feed\} \/>\s*<\/Suspense>/);
});

test("🔴 약속을 기다리는 자리는 <Suspense> 안쪽 하나뿐이다", () => {
  assert.equal(
    /await\s+getNotificationFeed/.test(appsPage),
    false,
    "🔴 머리말이 알림을 기다린다 — 첫 화면이 남의 서버만큼 늦어진다"
  );
  // 기다리는 자리는 Suspense 안에서 도는 조각들뿐이다.
  assert.match(appsPage, /async function HeaderBell\(\{ feed \}/);
  assert.match(appsPage, /const resolved = await feed;/);
});

test("🔴 종과 점이 **약속 하나**를 나눠 본다 — 왕복이 둘로 늘지 않는다", () => {
  // 종을 달면서 `getNotificationFeed` 를 한 번 더 부르면 그 사람의 모든 시스템을
  // **두 번** 두드린다(30초 캐시가 가려 주지만 캐시가 빈 첫 요청은 두 벌이다).
  const calls = appsPage.match(/getNotificationFeed\(/g) ?? [];
  assert.equal(calls.length, 1, `알림을 ${calls.length}번 모은다`);
  assert.match(appsPage, /<HeaderBell feed=\{feed\} \/>/);
  assert.match(appsPage, /<UnreadDot feed=\{feed\} clientId=\{tile\.clientId\} \/>/);
});

test("🔴 종은 줄의 **맨 오른쪽 끝**이다 — 아니면 폰에서 펼친 목록이 잘린다", () => {
  const logoutAt = appsPage.indexOf("<SignOutButton />");
  const bellAt = appsPage.indexOf("<HeaderBell");
  assert.ok(logoutAt > 0 && bellAt > 0, "머리말에서 찾지 못했다");
  assert.ok(bellAt > logoutAt, "🔴 종이 로그아웃보다 앞에 있다 — 목록이 화면 밖으로 잘린다");
});

/* ── 3. 🔴 사람은 세션에서만 온다 ─────────────────────────────────────── */

test("🔴 액션 둘 다 인자가 **줄 하나**뿐이다 — 사람 번호를 받지 않는다", () => {
  const names = ["dismissNotificationAction", "acknowledgeNotificationAction"];
  for (const name of names) {
    const start = bellAction.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, `${name} 을 찾지 못했다`);
    const signature = bellAction.slice(start, bellAction.indexOf("{", start));
    assert.equal(
      signature,
      `export async function ${name}(item: NotificationBellItem): Promise<void> `,
      `🔴 ${name} 의 인자가 바뀌었다 — 남의 알림을 지울 수 있는 자리다`
    );
  }
  assert.equal(names.length, 2, "표본이 비면 위 for 가 공짜로 통과한다");
});

test("🔴 사람은 쿠키에서 다시 읽는다 — 그리고 리다이렉트하지 않는 쪽이다", () => {
  assert.match(bellAction, /const session = await readSsoSession\(\);/);
  assert.match(bellAction, /return session\.userId;/);
  // 🔴 `requireSession` 같은 리다이렉트 함수를 쓰면 종 단추 하나에 보던 화면이
  //    로그인으로 튄다. 이 저장소에서 그 자리는 readSsoSession 하나다.
  assert.equal(
    /redirect\(/.test(bellAction),
    false,
    "🔴 액션이 리다이렉트한다 — ✕ 한 번에 화면이 튄다"
  );
});

test("🔴 정지·삭제된 사람은 적지 못한다 — 화면을 거치지 않고 불릴 수 있다", () => {
  assert.match(bellAction, /if \(session\.status !== "ACTIVE"\) return null;/);
});

test("🔴 시크릿 통로를 쓰지 않는다 — 같은 프로세스라 mutation 을 바로 부른다", () => {
  // 포털이 제 브라우저 세션으로 `/api/integration/...` 를 부르면 **자기 자신에게
  // 시크릿을 발급해 쓰는** 꼴이 된다. 그 통로는 사이트의 **서버**가 부르는 자리다.
  for (const forbidden of ["/api/integration", "client_secret", "fetch("]) {
    assert.equal(
      bellAction.includes(forbidden),
      false,
      `🔴 액션이 ${forbidden} 를 쓴다 — 포털이 제게 시크릿을 발급하는 길이다`
    );
  }
  assert.match(bellAction, /await recordDismissals\(userId, \[key\]\);/);
  assert.match(bellAction, /await recordAcknowledgements\(userId, rows\);/);
});

test("🔴 지문은 포털이 **제 목록에서** 짓는다 — 보내온 줄의 글자를 안 쓴다", () => {
  // 믿고 적으면 브라우저가 아무 값이나 넣어 그 알림을 영영 안 보이게 만들 수
  // 있다(거르는 조건이 「저장된 지문 == 지금 내용의 지문」이다).
  assert.match(bellAction, /const feed = await getNotificationFeed\(userId\);/);
  assert.match(bellAction, /acknowledgementRowsFor\(feed\.items, \[key\]\)/);
  assert.equal(
    /item\.subject|item\.detail|contentDigest\(/.test(bellAction),
    false,
    "🔴 액션이 받아 온 글자로 지문을 짓고 있다"
  );
});

test("🔴 받은 줄의 열쇠를 **가려서** 쓴다 — 두 길이 같은 함수를 통과한다", () => {
  const uses = bellAction.match(/const key = readBellKey\(item\);/g) ?? [];
  assert.equal(uses.length, 2, `가리는 자리가 ${uses.length}곳이다`);
  assert.equal((bellAction.match(/if \(key === null\) return;/g) ?? []).length, 2);
});

test("🔴 액션이 던지지 않는다 — 누름 처리 한가운데서 불린다", () => {
  // 여기서 예외가 새면 그 누름의 나머지 처리(바깥 눌러 접기·Esc)가 통째로 멈춘다.
  assert.equal(/\bthrow\b/.test(bellAction), false, "🔴 액션이 던진다");
  assert.equal((bellAction.match(/\} catch \(error\) \{/g) ?? []).length, 2);
  // 🔴 그렇다고 조용히 넘어가지 않는다 — 안 남기면 증상이 「지웠는데 그대로
  //    뜬다」 하나뿐이라 DB 를 의심할 단서가 없다.
  assert.equal((bellAction.match(/console\.error\(/g) ?? []).length, 2);
});

test("액션 파일은 서버 전용이다 — `\"use server\"` 가 첫 줄이다", () => {
  assert.match(read("src/lib/server/actions/notification-bell.ts"), /^"use server";\n/);
});

test("🔴 종을 그리는 조각은 **서버 컴포넌트**다 — 액션을 넘길 수 있는 유일한 모양", () => {
  // 🔴 주석을 걷어 낸 글자로 센다. 이 파일의 주석에 그 낱말이 적혀 있다.
  assert.equal(
    appsPage.includes('"use client"'),
    false,
    "🔴 화면이 클라이언트로 넘어갔다 — 서버 액션을 넘기는 전제가 깨진다"
  );
  assert.match(appsPage, /onAcknowledge=\{acknowledgeNotificationAction\}/);
  assert.match(appsPage, /onDismiss=\{dismissNotificationAction\}/);
});

/* ── 4. 🔴 묶음이 실제로 그리는 것 (불러 본다) ────────────────────────── */

/** 포털이 합쳐 내주는 한 줄. 🔴 전부 가짜 값이다. */
function row(overrides: Partial<NotificationBellItem> = {}): NotificationBellItem {
  return {
    key: "dss-leave:FAKE-0001",
    sourceId: "dss-leave",
    sourceName: "휴가 관리",
    id: "FAKE-0001",
    kind: "FAKE_APPROVAL",
    kindLabel: "결재 대기",
    subject: "FAKE-0001",
    detail: "가짜 줄입니다",
    href: "http://127.0.0.1:3700/approvals/0001",
    ...overrides,
  };
}

/** 그려진 트리에서 그 클래스를 가진 마디를 센다. */
function countByClass(node: unknown, className: string): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, child) => sum + countByClass(child, className), 0);
  }
  if (typeof node !== "object" || node === null || !("props" in node)) return 0;
  const element = node as { props: Record<string, unknown> };
  const own = element.props.className === className ? 1 : 0;
  return own + countByClass(element.props.children, className);
}

test("🔴 `onDismiss` 를 넘기면 줄마다 ✕ 가 그려진다", () => {
  const drawn = NotificationBell({
    items: [row(), row({ key: "dss-board:FAKE-0002", sourceId: "dss-board" })],
    count: 2,
    onDismiss: () => {},
  });
  assert.equal(countByClass(drawn, "dss-bell__dismiss"), 2);
});

test("🔴 안 넘기면 ✕ 가 **아예 안 생긴다** — 위 시험이 무엇을 재는지의 짝", () => {
  // 🔵 이 줄이 없으면 위 시험은 「단추가 늘 있다」로도 통과한다.
  const drawn = NotificationBell({ items: [row()], count: 1 });
  assert.equal(countByClass(drawn, "dss-bell__dismiss"), 0);
});

test("🔴 알림이 없으면 종 자체가 없다 — 이 집이 고른 모습이다", () => {
  // `showWhenEmpty` 를 안 넘겼으므로 0건인 사람의 머리말에는 종이 안 뜬다.
  // 🔴 **고장이 아니다.** 고른 까닭 넷은 화면 조각 머리말에 적혀 있다.
  assert.equal(NotificationBell({ items: [], count: 0 }), null);
  assert.equal(appsPage.includes("showWhenEmpty"), false, "빈 종을 세우기로 바뀌었다");
  assert.equal(appsPage.includes("emptyLabel"), false, "빈 칸 글자가 생겼다");
});

test("🔴 다크는 OS 설정을 따른다 — 이 포털에 `.dark` 표시가 없다", () => {
  // 기본값 "host" 는 조상에 .dark 가 있을 때만 어두워진다. 이 포털의 다크는
  // globals.css 의 @media (prefers-color-scheme: dark) 라, 기본값으로 두면
  // OS 가 어두운 사람의 화면에서 **종만 하얗게** 남는다.
  assert.match(appsPage, /colorScheme="system"/);
  assert.match(read("src/app/globals.css"), /@media \(prefers-color-scheme: dark\)/);
  const css = read("vendor/dss-ui/src/notification-bell/notification-bell.css");
  assert.match(css, /\.dss-bell\[data-color-scheme="system"\]/);
});

test("개수는 포털이 센 값 그대로다 — 줄 수로 다시 세지 않는다", () => {
  // 다시 세면 각 시스템의 종과 이 종이 서로 다른 숫자를 말하게 된다.
  assert.match(appsPage, /items=\{resolved\.items\}/);
  assert.match(appsPage, /count=\{resolved\.count\}/);
});

/* ── 5. 🔴 타일 빨간 점은 안 바뀌었다 (2026-11-18 사용자 결정) ─────────── */

test("🔴 점과 종은 공존한다 — 점을 그리는 코드가 그대로다", () => {
  // 역할이 다르다: 종은 「무슨 알림이 왔나」, 점은 「어느 시스템에 있나」.
  assert.match(appsPage, /async function UnreadDot\(\{/);
  assert.match(appsPage, /shouldShowTileDot\(resolved\.sources, clientId\)/);
  assert.match(appsPage, /<UnreadDot feed=\{feed\} clientId=\{tile\.clientId\} \/>/);
});

test("🔴 점을 찍는 시스템 목록을 넓히지 않았다", () => {
  // 🔵 지금 이 목록은 **알림 통로 여섯 가운데 하나**만 담는다(2026-09-23 사용자
  //    결정: 「빨간색 점은 개선요청에만 뜨면 돼」). 종을 다는 김에 넓히고
  //    싶어지는 자리라 못 박아 둔다 — 넓히는 것은 **다른 결정**이다.
  assert.match(
    merge,
    /const TILE_DOT_CLIENT_IDS: ReadonlySet<string> = new Set\(\["dss-improvements"\]\);/
  );
});

test("🔴 종을 그리는 조각은 점의 판정에 손대지 않는다", () => {
  const start = appsPage.indexOf("async function HeaderBell(");
  const end = appsPage.indexOf("export default async function AppsPage(");
  assert.ok(start > 0 && end > start, "조각을 찾지 못했다");
  const body = appsPage.slice(start, end);
  for (const forbidden of ["shouldShowTileDot", "sources", "isApprovalsTile"]) {
    assert.equal(body.includes(forbidden), false, `🔴 종이 ${forbidden} 를 건드린다`);
  }
});

test("🔴 관리자 화면에는 종을 달지 않았다 — 2026-11-18 사용자 결정", () => {
  const dir = path.resolve(ROOT, "src/app/admin");
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const next = path.join(at, entry.name);
      if (entry.isDirectory()) {
        walk(next);
        continue;
      }
      if (!entry.name.endsWith(".tsx")) continue;
      if (readFileSync(next, "utf8").includes("NotificationBell")) {
        found.push(path.relative(ROOT, next));
      }
    }
  };
  walk(dir);
  assert.deepEqual(found, [], `🔴 관리자 화면에 종이 생겼다: ${found.join(", ")}`);
});
