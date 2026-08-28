import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * 토큰류(세션 토큰, 인가 코드, 클라이언트 시크릿)를 DB에 저장하기 전에 씌우는 해시.
 *
 * 왜 해시하는가: DB 덤프가 유출되면 저장된 평문 토큰을 그대로 재생할 수 있다.
 * 해시만 저장하면 덤프를 얻어도 살아 있는 세션을 탈취할 수 없다.
 *
 * 비밀번호와 달리 salt/느린 해시가 필요 없다 — 이 값들은 32바이트 랜덤이라
 * 사전 공격 대상이 아니다.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * 길이가 다르면 timingSafeEqual이 예외를 던지므로 먼저 확인한다.
 * (A/S 시스템 token.ts:46과 같은 이유·같은 처리다.)
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// 비상 관리자 비밀번호 해시 파라미터.
// scrypt를 쓰는 이유: node:crypto 내장이라 의존성이 0이다. argon2/bcrypt는
// 네이티브 빌드가 필요해 NAS Docker 이미지 빌드를 복잡하게 만든다.
const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 32;
// 기본 maxmem(32MB)으로는 N=32768을 감당하지 못해 던진다. 128*N*r 이상 필요.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

/**
 * 콜백형 scrypt를 Promise로 감싼다.
 *
 * **scryptSync를 쓰지 않는 이유가 이 파일에서 가장 중요한 결정이다.**
 * scrypt는 일부러 비싸다 — 이 개발 PC에서 1회 62ms, 메모리 32MB다.
 * scryptSync는 그 62ms 동안 Node의 이벤트 루프를 통째로 멈춘다. 그러면
 * 비상 로그인 한 건이 그 시간만큼 **서버 전체**를 세운다: 같은 순간에 들어온
 * /api/oidc/token도, /jwks.json도 함께 멈추고, 그건 포털에 붙은 모든 사내
 * 시스템의 로그인이 멈춘다는 뜻이다.
 *
 * 콜백형은 libuv 스레드풀에서 돌아 이벤트 루프를 막지 않는다. 속도 제한이
 * 어떤 이유로 뚫려도 다른 시스템의 로그인은 살아남는다 — 두 방어가 서로를
 * 대신하지 않고 겹친다.
 *
 * 스레드풀 기본 크기는 4다. 동시에 4개까지만 계산되고 나머지는 줄을 서므로,
 * 메모리도 32MB × 4로 자연히 묶인다. 이 상한을 늘리지 않는다.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/** 형식: scrypt$N$r$p$<saltB64>$<hashB64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = await scryptAsync(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/**
 * 저장된 해시에 적힌 파라미터로 다시 계산해 비교한다. 파라미터를 상수에서
 * 읽지 않고 저장값에서 읽는 이유: 나중에 N을 올려도 옛 해시가 계속 검증된다.
 *
 * 어떤 이유로 실패하든 false를 반환하고 예외를 밖으로 내보내지 않는다.
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
      return false;
    }
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = await scryptAsync(
      password.normalize("NFKC"),
      salt,
      expected.length,
      { N, r, p, maxmem: 128 * N * r * 2 }
    );
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
