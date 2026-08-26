/**
 * RS256 서명 키쌍 생성.
 *
 * 개인키를 환경변수가 아니라 파일로 두는 이유:
 *  - NAS에서 백업 대상이 폴더 하나로 명확해진다.
 *  - 긴 PEM/JWK 값을 DSM GUI의 환경변수 칸에 넣는 건 다루기 나쁘다.
 *  - 환경변수는 프로세스 목록이나 오류 로그로 새기 쉽다.
 *
 * 사용법:
 *   npm run key:generate
 * 출력된 AUTH_ACTIVE_KID를 .env.local에 넣으면 그 키로 서명을 시작한다.
 *
 * 키를 잃어버려도 사용자 데이터는 하나도 잃지 않는다. 새로 만들면 되고,
 * 최악의 결과는 "전원 재로그인"이다.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";

async function main() {
  const dir = process.env.AUTH_KEYS_DIR ?? "./keys";

  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    modulusLength: 2048,
    extractable: true,
  });

  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);

  // kid를 사람이 짓지 않고 공개키의 지문(RFC 7638)으로 정한다.
  // 오타도 충돌도 원리적으로 생기지 않고, 같은 키는 항상 같은 kid를 갖는다.
  const kid = await calculateJwkThumbprint(publicJwk, "sha256");

  mkdirSync(dir, { recursive: true });

  const publicPath = join(dir, `${kid}.public.json`);
  const privatePath = join(dir, `${kid}.private.json`);

  const meta = { kid, alg: "RS256", use: "sig" };
  writeFileSync(publicPath, `${JSON.stringify({ ...publicJwk, ...meta }, null, 2)}\n`);
  writeFileSync(privatePath, `${JSON.stringify({ ...privateJwk, ...meta }, null, 2)}\n`);

  // Windows에서는 사실상 무시되지만 NAS(Linux)에서는 의미가 있다.
  try {
    chmodSync(privatePath, 0o600);
  } catch {
    // 파일 권한을 못 바꿔도 키 생성 자체는 성공한 것이다.
  }

  console.log("키쌍을 만들었습니다.\n");
  console.log(`  공개키: ${publicPath}`);
  console.log(`  개인키: ${privatePath}  ← 절대 커밋하지 마세요 (.gitignore에 있음)`);
  console.log("\n.env.local에 아래 줄을 넣으세요:\n");
  console.log(`AUTH_ACTIVE_KID=${kid}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
