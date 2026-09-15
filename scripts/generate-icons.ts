/**
 * 홈 화면 아이콘 생성.
 *
 * 회사 로고의 표식 — 파랑·흰색·빨강 정사각형 셋을 세로로 쌓은 것 — 을 그린다.
 * 로고의 글자("(주) 디에스에스 / DSS Co., Ltd.")는 넣지 않는다: 48픽셀에서
 * 읽히지 않고, 홈 화면에는 어차피 앱 이름이 아이콘 아래에 붙는다. 표식만
 * 남기는 편이 작은 크기에서 훨씬 또렷하다.
 *
 * 라이브러리를 쓰지 않는 이유는 hash.ts가 scrypt를 고른 것과 같다 — 그릴
 * 것이 사각형뿐이라 PNG를 직접 쓰는 편이 정확하고, 의존성이 0이면 NAS
 * 이미지 빌드가 단순해진다. (A/S 시스템은 sharp로 만들었지만 그쪽은 이미
 * 그 의존성이 있었다.)
 *
 * 사용법:
 *   npm run icons        → public/icons/ 아래 4개와 src/app/favicon.ico 를 다시 만든다
 *
 * 로고가 바뀌면 아래 색과 비율만 고치고 다시 돌리면 된다.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── 로고 색 ──
const BLUE: RGB = [0x00, 0x00, 0xcc];
const RED: RGB = [0xee, 0x00, 0x00];
const WHITE: RGB = [0xff, 0xff, 0xff];
/** 가운데 흰 사각형은 흰 바탕에 묻히므로 로고처럼 가는 테두리를 준다. */
const BORDER: RGB = [0xa8, 0xa8, 0xa8];

type RGB = [number, number, number];

/** 알파 없는 RGB 버퍼. 앱 아이콘은 불투명해야 한다(iOS는 투명을 검게 칠한다). */
class Canvas {
  readonly data: Uint8Array;
  constructor(readonly size: number, fill: RGB) {
    this.data = new Uint8Array(size * size * 3);
    for (let i = 0; i < size * size; i += 1) {
      this.data[i * 3] = fill[0];
      this.data[i * 3 + 1] = fill[1];
      this.data[i * 3 + 2] = fill[2];
    }
  }

  rect(x: number, y: number, w: number, h: number, color: RGB): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.size, Math.round(x + w));
    const y1 = Math.min(this.size, Math.round(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const i = (py * this.size + px) * 3;
        this.data[i] = color[0];
        this.data[i + 1] = color[1];
        this.data[i + 2] = color[2];
      }
    }
  }

  /** 속을 비운 사각형. 로고의 가운데 흰 칸을 그릴 때 쓴다. */
  outline(x: number, y: number, w: number, h: number, t: number, color: RGB): void {
    this.rect(x, y, w, t, color);
    this.rect(x, y + h - t, w, t, color);
    this.rect(x, y, t, h, color);
    this.rect(x + w - t, y, t, h, color);
  }
}

// ── PNG 쓰기 ──

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([head, typed, crc]);
}

/**
 * `alpha` 를 켜면 RGBA(색 유형 6)로 쓴다 — 알파는 전부 불투명(255)이라 그림은 같다.
 * 파비콘(ICO) 안의 PNG 에만 쓴다(아래 FAVICON 주석). 홈 화면 아이콘은 지금처럼 RGB 다.
 */
function encodePng(canvas: Canvas, options: { alpha?: boolean } = {}): Buffer {
  const { size, data } = canvas;
  const channels = options.alpha ? 4 : 3;
  const stride = size * channels + 1;

  // 각 줄 앞에 필터 바이트 0(필터 없음)을 붙인다 — 규격이 요구한다.
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    const at = y * stride;
    raw[at] = 0;
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 3;
      const to = at + 1 + x * channels;
      raw[to] = data[from];
      raw[to + 1] = data[from + 1];
      raw[to + 2] = data[from + 2];
      if (options.alpha) raw[to + 3] = 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 채널당 8비트
  ihdr[9] = options.alpha ? 6 : 2; // 색 유형 6 = RGBA, 2 = RGB(알파 없음)
  ihdr[10] = 0; // 압축: deflate
  ihdr[11] = 0; // 필터: 기본
  ihdr[12] = 0; // 인터레이스: 없음

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 여러 크기의 PNG 를 ICO 한 파일로 묶는다 — ICO 는 PNG 를 그대로 담을 수 있다
 * (Windows Vista 이후, 모든 요즘 브라우저가 읽는다).
 */
function encodeIco(images: readonly { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 예약
  header.writeUInt16LE(1, 2); // 1 = 아이콘
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 은 256 이다(규격)
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // 색 평면
    entry.writeUInt16LE(32, 6); // 픽셀당 비트
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

// ── 그리기 ──

/**
 * 표식을 그린다.
 *
 * `coverage`는 사각형 셋 전체가 캔버스 높이에서 차지하는 비율이다.
 * 보통 아이콘은 넉넉히 채우고, maskable은 좁게 잡는다 — 안드로이드 런처가
 * 기기별 모양(원형·스쿼클)으로 잘라내기 때문에, 가운데 80% 안에 들어가지
 * 않으면 모서리가 잘린다.
 */
function drawMark(size: number, coverage: number): Canvas {
  const canvas = new Canvas(size, WHITE);

  // 사각형 셋 + 사이 간격 둘. 간격은 사각형 한 변의 14%로 로고 비율에 맞춘다.
  const gapRatio = 0.09;
  const side = (size * coverage) / (3 + gapRatio * 2);
  const gap = side * gapRatio;

  const totalHeight = side * 3 + gap * 2;
  const x = (size - side) / 2;
  let y = (size - totalHeight) / 2;

  canvas.rect(x, y, side, side, BLUE);
  y += side + gap;

  // 가운데는 흰 칸 + 테두리. 바탕이 흰색이라 테두리가 없으면 사라진다.
  const stroke = Math.max(1, Math.round(side * 0.055));
  canvas.outline(x, y, side, side, stroke, BORDER);
  y += side + gap;

  canvas.rect(x, y, side, side, RED);

  return canvas;
}

// ── 실행 ──

const OUT = join(process.cwd(), "public", "icons");

const TARGETS = [
  // 보통 아이콘: 넉넉히 채운다.
  { file: "icon-192.png", size: 192, coverage: 0.82 },
  { file: "icon-512.png", size: 512, coverage: 0.82 },
  // 잘라내기용: 가운데 안전 영역 안에 들어가도록 좁게.
  { file: "icon-maskable-512.png", size: 512, coverage: 0.58 },
  // iOS는 스스로 모서리를 둥글게 깎으므로 보통 비율보다 살짝 좁게 둔다.
  { file: "apple-touch-icon.png", size: 180, coverage: 0.76 },
];

mkdirSync(OUT, { recursive: true });

for (const target of TARGETS) {
  const png = encodePng(drawMark(target.size, target.coverage));
  writeFileSync(join(OUT, target.file), png);
  console.log(`  ${target.file.padEnd(24)} ${target.size}×${target.size}  ${png.length}바이트`);
}

console.log(`\n${TARGETS.length}개를 public/icons/ 에 만들었습니다.`);

/**
 * 데스크톱 북마크 · 탭 아이콘(src/app/favicon.ico).
 *
 * 2026-09-15 사용자: 북마크에 Next.js 기본 삼각형이 떴다 — 프로젝트를 만들 때 들어온
 * 파일 그대로였다. 홈 화면 아이콘과 같은 표식을 같은 비율(보통 아이콘 0.82)로
 * 16 · 32 · 48 · 256 에 그린다. 작은 크기는 큰 그림을 줄이지 않고 **그 크기에서 직접
 * 그린다** — 줄이면 사각형 가장자리가 뭉개진다.
 *
 * 🔴 **RGBA(색 유형 6)로 쓴다.** Next.js 는 ICO 안의 PNG 를 RGBA 로만 풀어서, 알파
 * 없는 RGB 면 「The PNG is not in RGBA format!」으로 화면이 전부 막힌다(A/S 시스템에서
 * 같은 날 실제로 났다). 알파는 전부 불투명이라 그림은 홈 화면 아이콘과 같다.
 */
const FAVICON = join(process.cwd(), "src", "app", "favicon.ico");
const FAVICON_SIZES = [16, 32, 48, 256];

const favicon = encodeIco(
  FAVICON_SIZES.map((size) => ({ size, png: encodePng(drawMark(size, 0.82), { alpha: true }) }))
);
writeFileSync(FAVICON, favicon);
console.log(`  ${"src/app/favicon.ico".padEnd(24)} ${FAVICON_SIZES.join("·")}  ${favicon.length}바이트`);
