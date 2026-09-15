import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/**
 * ============================================================================
 * 데스크톱 북마크 아이콘 = 홈 화면 아이콘 (2026-09-15 사용자 요청)
 * ============================================================================
 * 북마크 · 탭은 src/app/favicon.ico 를 쓰는데, 그 파일이 프로젝트를 만들 때 들어온
 * **Next.js 기본 로고(검은 원 안의 흰 삼각형)** 그대로였다. 이제 홈 화면 아이콘과
 * 같은 표식(파랑 · 흰색 · 빨강 사각형)을 scripts/generate-icons.ts 가 함께 그린다.
 * ============================================================================
 */

/** create-next-app 이 넣어 준 기본 favicon.ico 의 SHA-256(25,931바이트). */
const NEXT_DEFAULT_FAVICON_SHA256 = "2b8ad2d33455a8f736fc3a8ebf8f0bdea8848ad4c0db48a2833bd0f9cd775932";

const favicon = readFileSync("src/app/favicon.ico");

type Entry = { size: number; png: Buffer };

function icoEntries(buffer: Buffer): Entry[] {
  assert.equal(buffer.readUInt16LE(2), 1, "ICO 파일이 아니다");
  const count = buffer.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const at = 6 + index * 16;
    const length = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    assert.ok(offset + length <= buffer.length, "그림이 파일 밖을 가리킨다");
    return { size: buffer[at] === 0 ? 256 : buffer[at], png: buffer.subarray(offset, offset + length) };
  });
}

/**
 * RGBA PNG 의 한 픽셀. 생성기가 줄마다 필터 0(없음)으로 쓰므로 IDAT 를 풀면 곧 픽셀이다
 * (scripts/generate-icons.ts 의 encodePng).
 */
function pixelAt(png: Buffer, x: number, y: number): number[] {
  const size = png.readUInt32BE(16);
  const idat: Buffer[] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = size * 4 + 1;
  assert.equal(raw[y * stride], 0, "필터 0 이 아닌 줄이 있다");
  const from = y * stride + 1 + x * 4;
  return [...raw.subarray(from, from + 4)];
}

test("🔴 파비콘이 Next.js 기본 로고가 아니다", () => {
  assert.notEqual(createHash("sha256").update(favicon).digest("hex"), NEXT_DEFAULT_FAVICON_SHA256);
});

test("🔴 16 · 32 · 48 · 256 이 RGBA PNG 로 들어 있다 — RGB 면 Next.js 가 못 풀어 화면이 막힌다", () => {
  const entries = icoEntries(favicon);
  assert.deepEqual(
    entries.map((entry) => entry.size),
    [16, 32, 48, 256]
  );
  for (const { size, png } of entries) {
    assert.equal(png.readUInt32BE(16), size, `${size} 그림의 가로가 다르다`);
    assert.equal(png.readUInt32BE(20), size, `${size} 그림의 세로가 다르다`);
    assert.equal(png[25], 6, `${size} 그림이 RGBA 가 아니다`);
  }
});

test("256 그림이 홈 화면과 같은 표식이다 — 위 파랑 · 아래 빨강 · 모서리 흰 바탕, 모두 불투명", () => {
  const big = icoEntries(favicon).find((entry) => entry.size === 256);
  assert.ok(big);
  assert.deepEqual(pixelAt(big.png, 128, 55), [0x00, 0x00, 0xcc, 0xff], "위 칸이 파랑이 아니다");
  assert.deepEqual(pixelAt(big.png, 128, 200), [0xee, 0x00, 0x00, 0xff], "아래 칸이 빨강이 아니다");
  assert.deepEqual(pixelAt(big.png, 4, 4), [0xff, 0xff, 0xff, 0xff], "모서리가 불투명한 흰 바탕이 아니다");
});

test("아이콘 스크립트가 파비콘도 만든다 — 그림의 출처가 한 곳이다", () => {
  const script = readFileSync("scripts/generate-icons.ts", "utf8");
  assert.ok(script.includes('join(process.cwd(), "src", "app", "favicon.ico")'), "파비콘을 스크립트가 만들지 않는다");
  assert.ok(script.includes("encodePng(drawMark(size, 0.82), { alpha: true })"), "파비콘을 RGBA 로 그리지 않는다");
});
