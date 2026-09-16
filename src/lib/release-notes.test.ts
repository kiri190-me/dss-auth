import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatReleaseDate } from "./format";
import { APP_VERSION, OWN_SYSTEM, RELEASES, type ReleaseSystem } from "./release-notes";

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
  const known: ReleaseSystem[] = ["통합 로그인", "A/S 관리", "계측기 관리"];
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

test("배포 날짜를 한글로 적는다", () => {
  assert.equal(formatReleaseDate("2026-09-15"), "2026년 9월 15일");
  // 앞의 0 을 떼고 적는다 — "09월 05일" 이 아니라 "9월 5일".
  assert.equal(formatReleaseDate("2026-01-05"), "2026년 1월 5일");
  assert.equal(formatReleaseDate("2026-12-31"), "2026년 12월 31일");
});
