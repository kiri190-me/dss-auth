import "server-only";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { importJWK, type CryptoKey, type JWK } from "jose";
import { getActiveKid, getKeysDir } from "@/lib/config/env";
import { toPublicJwk } from "./public-jwk";

type KeyMaterial = {
  /** 검증용 공개키 전부. 옛 키도 남아 있어야 아직 유효한 토큰이 검증된다. */
  publicJwks: JWK[];
  /** 지금 서명에 쓸 키 하나. */
  signingKey: CryptoKey;
  signingKid: string;
};

// 프로세스당 한 번만 읽는다. 매 요청 디스크를 읽으면 DS218+에서 손해다.
let cached: KeyMaterial | null = null;

async function load(): Promise<KeyMaterial> {
  const dir = getKeysDir();
  const activeKid = getActiveKid();

  let fileNames: string[];
  try {
    fileNames = await readdir(dir);
  } catch {
    throw new Error(
      `서명 키 폴더(${dir})를 읽을 수 없습니다. npm run key:generate 를 먼저 실행하세요.`
    );
  }

  const publicJwks: JWK[] = [];
  for (const name of fileNames.filter((f) => f.endsWith(".public.json"))) {
    const raw = await readFile(join(dir, name), "utf8");
    publicJwks.push(toPublicJwk(JSON.parse(raw) as JWK));
  }

  if (publicJwks.length === 0) {
    throw new Error(
      `${dir}에 공개키가 없습니다. npm run key:generate 를 먼저 실행하세요.`
    );
  }

  let privateRaw: string;
  try {
    privateRaw = await readFile(join(dir, `${activeKid}.private.json`), "utf8");
  } catch {
    throw new Error(
      `AUTH_ACTIVE_KID(${activeKid})에 해당하는 개인키 파일이 ${dir}에 없습니다.`
    );
  }

  const privateJwk = JSON.parse(privateRaw) as JWK;
  const signingKey = (await importJWK(privateJwk, "RS256")) as CryptoKey;

  // 서명 키의 공개 짝이 JWKS에 없으면, 우리가 발급한 토큰을 아무도
  // 검증할 수 없다. 조용히 넘어가면 "로그인은 되는데 각 시스템이 전부
  // 거절하는" 상태가 되므로 여기서 확실히 막는다.
  if (!publicJwks.some((jwk) => jwk.kid === activeKid)) {
    throw new Error(
      `AUTH_ACTIVE_KID(${activeKid})의 공개키가 JWKS에 없습니다. ${activeKid}.public.json을 확인하세요.`
    );
  }

  return { publicJwks, signingKey, signingKid: activeKid };
}

async function material(): Promise<KeyMaterial> {
  cached ??= await load();
  return cached;
}

/** /jwks.json이 그대로 내보낼 형태. */
export async function getPublicJwks(): Promise<{ keys: JWK[] }> {
  return { keys: (await material()).publicJwks };
}

export async function getSigningKey(): Promise<{ key: CryptoKey; kid: string }> {
  const loaded = await material();
  return { key: loaded.signingKey, kid: loaded.signingKid };
}
