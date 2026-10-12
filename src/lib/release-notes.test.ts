import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatReleaseDate } from "./format";
import {
  APP_VERSION,
  FOLDER_HELPER_NOTICE,
  OWN_SYSTEM,
  RELEASES,
  type ReleaseSystem,
} from "./release-notes";

/** "1.2" → [1, 2]. "1.10" 이 "1.9" 보다 뒤라는 것을 글자 비교로는 못 가린다. */
function parts(version: string): number[] {
  return version.split(".").map(Number);
}

/** a 가 b 보다 큰가 (앞자리부터 숫자로 견준다). */
function isNewer(a: string, b: string): boolean {
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

test("최신이 맨 앞이다 — 날짜가 내림차순", () => {
  // 화면이 이 차례를 그대로 그린다. 새 항목을 실수로 맨 뒤에 붙이면 여기서 걸린다.
  // 번호는 시스템마다 따로 세므로 목록 전체로는 견주지 않는다 — 아래 시험이 시스템별로 본다.
  for (let i = 1; i < RELEASES.length; i += 1) {
    const [older, newer] = [RELEASES[i], RELEASES[i - 1]];
    assert.ok(
      newer.date >= older.date,
      `${newer.system} v${newer.version}(${newer.date}) 이(가) ${older.system} v${older.version}(${older.date}) 보다 늦은 날이어야 한다`
    );
  }
});

test("한 시스템 안에서는 번호도 내림차순이고 겹치지 않는다", () => {
  // 시스템이 섞여 있어도 제 시스템 것끼리는 차례가 서야 한다.
  // A/S 1.3 과 통합 로그인 1.3 은 남남이므로 서로 겹쳐도 된다.
  for (const system of new Set(RELEASES.map((release) => release.system))) {
    const versions = RELEASES.filter((release) => release.system === system).map((r) => r.version);
    assert.equal(new Set(versions).size, versions.length, `${system} 에 같은 번호가 둘 있다`);
    for (let i = 1; i < versions.length; i += 1) {
      assert.ok(
        isNewer(versions[i - 1], versions[i]),
        `${system}: ${versions[i - 1]} 이(가) ${versions[i]} 보다 앞에 있어야 한다`
      );
    }
  }
});

test("번호와 날짜가 정해진 꼴이다", () => {
  for (const release of RELEASES) {
    // 도커 이미지 태그(dss-auth:1.2)와 같은 번호를 쓴다.
    assert.match(release.version, /^\d+\.\d+(\.\d+)?$/, release.version);
    // 날짜는 formatReleaseDate 가 쪼개 쓰므로 꼴이 어긋나면 화면이 깨진다.
    assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/, release.date);
  }
});

test("항목이 비어 있는 배포는 없다", () => {
  // 적을 것이 없다고 빈 채로 두면 직원 눈에는 아무 일도 없던 배포로 보인다.
  // 그럴 때도 "겉으로 보이는 변화는 없고 속을 손봤습니다" 한 줄은 적는다.
  for (const release of RELEASES) {
    assert.ok(release.items.length > 0, `v${release.version} 에 항목이 없다`);
    assert.ok(release.title.length > 0, `v${release.version} 에 한 줄 요약이 없다`);
    for (const item of release.items) {
      assert.ok(item.text.length > 0, `v${release.version} 에 빈 항목이 있다`);
    }
  }
});

test("화면에 보이는 번호는 통합 로그인 항목 가운데 맨 앞의 것이다", () => {
  // 다른 시스템 항목이 맨 앞에 와도 포털의 번호는 흔들리지 않아야 한다 —
  // 그 번호는 지금 돌고 있는 포털 이미지의 태그다.
  const own = RELEASES.find((release) => release.system === OWN_SYSTEM);
  assert.ok(own !== undefined, "통합 로그인 항목이 하나는 있어야 한다");
  assert.equal(APP_VERSION, own.version);
});

test("항목마다 시스템이 적혀 있다", () => {
  // 2026-09-28: 개선요청 · PO / 내자의 자리를 더했다. 아직 두 시스템의 글은
  // 하나도 없지만(배포하는 날 붙인다), 여기 목록이 좁으면 그날 이 시험이
  // 애먼 곳에서 걸린다.
  const known: ReleaseSystem[] = [
    "통합 로그인",
    "A/S 관리",
    "계측기 관리",
    "개선요청",
    "PO / 내자",
  ];
  for (const release of RELEASES) {
    assert.ok(known.includes(release.system), `모르는 시스템: ${release.system}`);
  }
});

test("package.json 의 version 과 같다", () => {
  // 배포하면서 번호 올리기를 잊으면 여기서 걸린다. 셋(이 파일 · package.json ·
  // 도커 이미지 태그)이 같은 번호여야 하는데, 앞의 둘은 기계가 지킬 수 있다.
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as { version: string };
  assert.equal(
    pkg.version,
    APP_VERSION,
    "package.json 의 version 과 RELEASES 맨 앞 번호를 같이 올려야 한다"
  );
});

/**
 * ============================================================================
 * 🔴 폴더 열기 도우미 칸 — 「맨 위에 상시」를 지키는 시험들
 * ============================================================================
 * 사용자 요구는 **자리**다: 소식은 쌓이면서 밀려 내려가므로 글로 넣으면 안 되고,
 * 목록보다 위에 늘 있어야 한다(2026-10-12). 아래 시험들이 그 둘(글이 아니다 ·
 * 목록보다 앞이다)을 못 박고, 거기에 「이 공개 화면에 사내 주소를 적지 않는다」를
 * 더한다(release-notes.ts 머리말의 ⚠️).
 * ============================================================================
 */

/** page.tsx 원본 — 화면이 **어느 차례로** 그리는지는 값으로는 볼 수 없다. */
function releaseNotesPageSource(): string {
  return readFileSync(new URL("../app/release-notes/page.tsx", import.meta.url), "utf8");
}

test("도우미 칸은 소식 글이 아니다 — RELEASES 안에 없다", () => {
  // 글로 넣으면 다음 배포에 밀려 내려간다. 그것이 이 칸을 따로 둔 까닭이다.
  const everyReleaseText = RELEASES.flatMap((release) => [
    release.title,
    ...release.items.map((item) => item.text),
  ]).join("\n");
  for (const paragraph of FOLDER_HELPER_NOTICE.body) {
    assert.equal(everyReleaseText.includes(paragraph), false, paragraph);
  }
});

test("화면은 도우미 칸을 소식 목록보다 **위에** 그린다", () => {
  const source = releaseNotesPageSource();
  const notice = source.indexOf("FOLDER_HELPER_NOTICE.title");
  const list = source.indexOf("RELEASES.map");
  assert.ok(notice > 0, "page.tsx 가 도우미 칸을 그리지 않는다");
  assert.ok(list > 0, "page.tsx 가 소식 목록을 그리지 않는다");
  assert.ok(notice < list, "도우미 칸이 소식 목록보다 앞에 와야 한다");
});

test("도우미 칸에 사내 주소가 없다 — 로그인 없이 열리는 화면이다", () => {
  // 머리말의 ⚠️ 와 같은 규율. 주소를 적으면 IP 가 바뀌는 날 이 글이 틀린 말이 되고,
  // 그 전에 이미 밖에서 읽을 수 있는 자리에 사내 주소를 적은 것이 된다.
  const everyWord = [
    FOLDER_HELPER_NOTICE.title,
    FOLDER_HELPER_NOTICE.summary,
    ...FOLDER_HELPER_NOTICE.body,
    FOLDER_HELPER_NOTICE.linkText,
    FOLDER_HELPER_NOTICE.linkHref,
  ].join("\n");
  assert.equal(/https?:\/\//.test(everyWord), false, "주소를 적었다");
  assert.equal(/\d{1,3}(\.\d{1,3}){3}/.test(everyWord), false, "IP 를 적었다");
  assert.equal(everyWord.includes("\\\\"), false, "공유폴더 UNC 를 적었다");
  // 단추는 포털 제 경로여야 한다 — 남의 사이트로 바로 보내지 않는다.
  assert.match(FOLDER_HELPER_NOTICE.linkHref, /^\/[a-z-]+$/);
});

test("도우미 칸이 어디서 무엇을 누르는지 말해 준다", () => {
  // A/S 에는 「설치 자리」라는 한 화면이 따로 없다 — [설치 명령 복사]는 [폴더 열기]를
  // 누른 뒤에 그 자리에 나타난다. 그래서 글이 누르는 차례를 적어야 길을 잃지 않는다.
  const body = FOLDER_HELPER_NOTICE.body.join("\n");
  for (const word of ["A/S", "[폴더 열기]", "[설치 명령 복사]", "PowerShell"]) {
    assert.ok(body.includes(word), `도우미 안내에 「${word}」 가 없다`);
  }
  assert.ok(FOLDER_HELPER_NOTICE.title.length > 0);
  assert.ok(FOLDER_HELPER_NOTICE.linkText.length > 0);
  for (const paragraph of FOLDER_HELPER_NOTICE.body) {
    assert.ok(paragraph.length > 0, "빈 문단이 있다");
  }
});

/**
 * 🔴 **2026-10-12 에 실제로 틀린 말이 나갔다.** 「이미 설치했더라도 **새 폴더가 늘면** 한 번
 * 더 받아 주세요」라고 적었더니 사용자가 「새 수리건이 들어오면 다시 설치해야 하냐」로 읽었다.
 * 도우미가 아는 것은 **루트**이고 그 아래는 전부 열린다 — 수리 건 폴더는 그 아래에 생기므로
 * 다시 깔 일이 없다(까닭은 release-notes.ts 의 FOLDER_HELPER_NOTICE 머리말).
 * 이 시험은 **그 낱말이 다시 들어오는 것**을 막는다.
 */
test("「새 폴더가 늘면 다시 깔라」로 읽히지 않는다 — 루트 아래는 그냥 열린다", () => {
  const body = FOLDER_HELPER_NOTICE.body.join("\n");
  for (const misleading of [
    "새 폴더가 늘면",
    "새 폴더가 생기",
    "폴더가 늘면",
    "폴더가 늘어나면",
    "폴더가 늘 때",
    "설치할 때 알게 된 폴더만",
  ]) {
    assert.equal(body.includes(misleading), false, `오해를 부르는 말: ${misleading}`);
  }
  // 막기만 해서는 다음 사람이 같은 자리에 다른 틀린 말을 넣는다 — 맞는 말도 함께 못 박는다.
  assert.ok(body.includes("새 수리 건"), "새 수리 건은 그냥 열린다는 말이 있어야 한다");
  assert.ok(body.includes("다시 설치할 일은 없습니다"));
  assert.ok(body.includes("새로운 공유폴더 자리"), "다시 받는 때가 적혀 있어야 한다");
});

test("도우미 칸은 날짜가 지나면 거짓이 되는 말을 담지 않는다 — 상시 노출이다", () => {
  // 「오늘」 · 「2026-10-12」 같은 말은 소식 글의 몫이다. 이 칸은 늘 떠 있으므로
  // 그런 문장을 담으면 다음 날부터 틀린 글이 상시 노출된다.
  const everyWord = [
    FOLDER_HELPER_NOTICE.title,
    FOLDER_HELPER_NOTICE.summary,
    ...FOLDER_HELPER_NOTICE.body,
  ].join("\n");
  for (const dated of ["오늘", "이번 주", "지금 한 번", "\\d{4}-\\d{2}-\\d{2}"]) {
    assert.equal(new RegExp(dated).test(everyWord), false, `날짜에 매인 말: ${dated}`);
  }
});

test("도우미 칸을 접을 수 있다 — 자바스크립트 없이, 제목은 접혀도 보인다", () => {
  const source = releaseNotesPageSource();
  // 🔴 이 저장소에는 클라이언트 지시문이 한 줄도 없다(apps/page.tsx 의 그 주석).
  //    접기 때문에 그 틀이 들어오면 여기서 걸린다. 글자가 아니라 **지시문**을 찾는다 —
  //    주석에서 그 말을 언급하는 것까지 막으면 까닭을 적을 수 없다
  //    (notifications/settings-form.test.ts 가 쓰는 것과 같은 자(尺)다).
  const clientDirective = /^\s*["']use client["'];?\s*$/;
  assert.equal(
    source.split("\n").some((line) => clientDirective.test(line)),
    false,
    "클라이언트 조각이 들어왔다"
  );
  assert.ok(source.includes("<details"), "접히지 않는다");
  // 🔴 **처음은 접힌 채다**(사용자 결정 2026-10-12: 「기본적으로는 접혀져 있도록」).
  //    `open` 을 도로 넣으면 여기서 걸린다 — 고른 것이 아니라 정해진 것이다.
  assert.equal(/<details\s+open\b/.test(source), false, "처음부터 펴져 있으면 안 된다");
  // 🔴 제목이 <summary> 안이라 접어도 사라지지 않는다 = 「최상단 상시」가 산다.
  const summaryStart = source.indexOf("<summary");
  const summaryEnd = source.indexOf("</summary>");
  assert.ok(summaryStart > 0 && summaryEnd > summaryStart, "<summary> 가 없다");
  const summary = source.slice(summaryStart, summaryEnd);
  assert.ok(
    summary.includes("FOLDER_HELPER_NOTICE.title"),
    "제목이 <summary> 밖에 있으면 접었을 때 통째로 사라진다"
  );
  // 🔴 접힌 채로 제목만 있으면 아무도 펴 보지 않는다 — 한 줄이 함께 보여야 한다.
  assert.ok(
    summary.includes("FOLDER_HELPER_NOTICE.summary"),
    "접힌 상태에서 무엇이 들었는지 짐작할 줄이 없다"
  );
  // 🔴 그 한 줄은 **짧아야** 한다. 접어 둔 사람에게도 늘 보이는 글자다.
  assert.ok(
    FOLDER_HELPER_NOTICE.summary.length <= 40,
    `접힌 줄이 ${FOLDER_HELPER_NOTICE.summary.length} 자다 — 한 줄로 줄여라`
  );
});

test("배포 날짜를 한글로 적는다", () => {
  assert.equal(formatReleaseDate("2026-09-15"), "2026년 9월 15일");
  // 앞의 0 을 떼고 적는다 — "09월 05일" 이 아니라 "9월 5일".
  assert.equal(formatReleaseDate("2026-01-05"), "2026년 1월 5일");
  assert.equal(formatReleaseDate("2026-12-31"), "2026년 12월 31일");
});
