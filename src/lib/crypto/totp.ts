import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 시간 기반 일회용 비밀번호 (TOTP, RFC 6238).
 *
 * 라이브러리를 쓰지 않는 이유는 hash.ts가 scrypt를 고른 것과 같다 —
 * node:crypto의 HMAC만 있으면 되고, 의존성이 0이면 NAS Docker 이미지 빌드가
 * 단순해진다. 직접 구현한 암호 코드는 대개 나쁜 생각이지만, TOTP는
 * "HMAC 한 번 + 자릿수 자르기"가 전부이고 **RFC에 공식 시험값이 있어**
 * 구현이 맞는지 증명할 수 있다는 점이 다르다(totp.test.ts 참조).
 *
 * server-only를 붙이지 않는다 — 시험값으로 검증해야 하는 코드다.
 */

/** RFC 6238 기본값. 인증 앱들이 이 값을 가정한다. */
const STEP_SECONDS = 30;
const DIGITS = 6;
/** 표준이 정한 알고리즘. SHA256/512도 규격에 있으나 앱 호환이 들쭉날쭉하다. */
const ALGORITHM = "sha1";

/** RFC 4648 base32 — 인증 앱에 넣을 때 쓰는 표기. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  // 패딩(=)은 붙이지 않는다. 인증 앱은 대부분 패딩 없는 형태를 기대하고,
  // 사람이 손으로 옮겨 적을 때도 짧은 편이 낫다.
  return out;
}

export function base32Decode(input: string): Buffer {
  // 사람이 옮겨 적은 값을 받는다 — 공백과 소문자, 패딩을 너그럽게 다룬다.
  // 알파벳에 없는 글자는 여기서 걸러지지 않고 아래에서 예외가 된다.
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`base32에 없는 글자입니다: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * 새 비밀키. 20바이트(160비트)는 RFC 4226이 권하는 SHA-1 HMAC 키 길이다.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** 유닉스 시각(초)을 카운터로. */
export function timeStep(unixSeconds: number): number {
  return Math.floor(unixSeconds / STEP_SECONDS);
}

/**
 * 주어진 카운터의 코드.
 *
 * digits를 인자로 받는 이유는 RFC 6238의 시험값이 8자리이기 때문이다.
 * 실제 사용은 6자리다.
 */
export function totpCode(secret: string, step: number, digits: number = DIGITS): string {
  const key = base32Decode(secret);

  // 카운터는 8바이트 big-endian. Number는 2^53까지만 정확하지만 카운터가
  // 그 값에 닿으려면 30초 × 2^53 이라 걱정할 범위가 아니다.
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const digest = createHmac(ALGORITHM, key).update(counter).digest();

  // 동적 절단(RFC 4226 §5.3): 마지막 바이트의 하위 4비트가 시작 위치다.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

export type TotpVerification =
  | { ok: true; step: number }
  | { ok: false };

/**
 * 코드를 확인한다.
 *
 * 앞뒤 한 칸(±30초)까지 받아 준다. 사람의 시계와 서버 시계가 조금 어긋나는
 * 것은 흔하고, 코드가 바뀌는 순간에 눌러 실패하는 것도 흔하다. 더 넓히면
 * 추측 성공률이 그만큼 올라가므로 한 칸에서 멈춘다.
 *
 * 성공하면 그 카운터를 함께 돌려준다. 호출부가 그 값을 저장해 두면 같은
 * 코드를 30초 안에 두 번 쓰는 것을 막을 수 있다 — 어깨너머로 본 코드가
 * 곧바로 재사용되는 경우다.
 *
 * 문자열 비교에 timingSafeEqual을 쓴다. 6자리라 실효는 작지만, 비교 시간으로
 * 앞자리부터 맞춰 나가는 길을 아예 열어 두지 않는다.
 */
export function verifyTotp(params: {
  secret: string;
  code: string;
  /** 검증 기준 시각(유닉스 초). */
  now: number;
  /** 이 카운터 이하의 코드는 이미 쓴 것으로 보고 거절한다. */
  lastUsedStep?: number | null;
  window?: number;
}): TotpVerification {
  const code = params.code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(code)) return { ok: false };

  const window = params.window ?? 1;
  const current = timeStep(params.now);

  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    // 이미 쓴 카운터는 건너뛴다. 재사용을 막는 지점이다.
    if (params.lastUsedStep != null && step <= params.lastUsedStep) continue;

    let expected: string;
    try {
      expected = totpCode(params.secret, step);
    } catch {
      // 비밀키가 깨졌다면 어떤 코드도 통과시키지 않는다.
      return { ok: false };
    }
    if (safeEqualString(expected, code)) return { ok: true, step };
  }

  return { ok: false };
}

function safeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 인증 앱이 QR로 읽는 주소(otpauth://).
 *
 * QR 이미지를 만들지 않는 이유: 그러려면 라이브러리가 필요하고, 비상 계정은
 * 한 자릿수라 주소나 키를 손으로 넣어도 된다. 인증 앱들은 대부분 "키 직접
 * 입력"을 지원한다.
 */
export function totpUri(params: {
  secret: string;
  /** 앱 목록에 뜨는 계정 이름. 보통 로그인 아이디. */
  account: string;
  /** 앱 목록에 뜨는 발급자. 여러 서비스를 넣어 둔 앱에서 구분된다. */
  issuer: string;
}): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
