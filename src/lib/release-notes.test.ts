import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatReleaseDate } from "./format";
import { APP_VERSION, RELEASES } from "./release-notes";

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

test("최신이 맨 앞이다 — 번호도 날짜도 내림차순", () => {
  // 화면이 이 차례를 그대로 그리고, '최신' 배지도 맨 앞에만 붙는다.
  // 새 항목을 실수로 맨 뒤에 붙이면 여기서 걸린다.
  for (let i = 1; i < RELEASES.length; i += 1) {
    const [older, newer] = [RELEASES[i], RELEASES[i - 1]];
    assert.ok(
      isNewer(newer.version, older.version),
      `${newer.version} 이(가) ${older.version} 보다 앞에 있어야 한다`
    );
    assert.ok(
      newer.date >= older.date,
      `${newer.version}(${newer.date}) 이(가) ${older.version}(${older.date}) 보다 늦은 날이어야 한다`
    );
  }
});

test("번호가 겹치지 않는다", () => {
  const versions = RELEASES.map((r) => r.version);
  assert.equal(new Set(versions).size, versions.length);
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

test("화면에 보이는 번호는 맨 앞 항목의 번호다", () => {
  assert.equal(APP_VERSION, RELEASES[0].version);
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
