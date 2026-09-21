import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeProtectedHeader, generateKeyPair, jwtVerify, type JWTPayload } from "jose";
import {
  PORTAL_SERVICE_TOKEN_PURPOSES,
  PORTAL_SERVICE_TOKEN_TTL_SECONDS,
  signPortalServiceToken,
  type PortalServiceTokenPurpose,
} from "./service-token";

/**
 * 🔴 이 시험은 **저쪽(A/S)의 검증을 여기서 그대로 다시 돌린다.**
 *
 * 저장소가 둘이라 컴파일러가 두 파일을 견주어 주지 못한다. 한쪽만 고치면
 * 그 통로만 401 이 되고, 증상은 「알림이 안 온다」 하나로 뭉뚱그려진다. 그래서
 * A/S 의 lib/auth/portal-service-token.ts 가 요구하는 것을 아래에 **글자 그대로**
 * 옮겨 적고, 우리가 구운 토큰을 그것으로 검증한다.
 *
 * 저쪽을 고치는 사람은 이 시험도 함께 고쳐야 한다 — 그러라고 적어 둔 것이다.
 */

/** A/S 의 PORTAL_TOKEN_PURPOSES 를 그대로 옮긴 값. */
const AS_PURPOSES = {
  notificationsRead: "dss.notifications.read",
  notificationSettingsRead: "dss.notification-settings.read",
  notificationSettingsWrite: "dss.notification-settings.write",
} as const;

/** A/S 의 PORTAL_TOKEN_MAX_LIFETIME_SECONDS. */
const AS_MAX_LIFETIME_SECONDS = 600;
/** A/S 의 PORTAL_TOKEN_CLOCK_TOLERANCE_SECONDS. */
const AS_CLOCK_TOLERANCE_SECONDS = 30;

const ISSUER = "http://192.168.0.12:3100";
const AUDIENCE = "rf-service-system";
const SUBJECT = "8f0b3a1e-0000-4000-8000-000000000001";

/**
 * 시험용 열쇠 한 벌. 처음 쓸 때 만든다 — 이 저장소의 시험은 CJS 로 변환되어
 * 돌아서 최상위 await 을 쓸 수 없다.
 */
let cachedKeys: Awaited<ReturnType<typeof generateKeyPair>> | null = null;
async function keys() {
  cachedKeys ??= await generateKeyPair("RS256", { extractable: true });
  return cachedKeys;
}

async function bake(
  purpose: PortalServiceTokenPurpose = PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead,
  over: { audience?: string; subject?: string; nowSeconds?: number } = {}
) {
  return signPortalServiceToken(
    {
      issuer: ISSUER,
      audience: over.audience ?? AUDIENCE,
      subject: over.subject ?? SUBJECT,
      purpose,
      key: (await keys()).privateKey,
      kid: "2026-09-01",
    },
    over.nowSeconds
  );
}

/** A/S 의 verifyPortalTokenWithKey 를 그대로 옮긴 판정. */
async function verifyLikeTheOtherSide(
  token: string,
  purpose: PortalServiceTokenPurpose,
  audience = AUDIENCE
): Promise<{ ok: true; subject: string; payload: JWTPayload } | { ok: false; reason: string }> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, (await keys()).publicKey, {
      issuer: ISSUER,
      audience,
      clockTolerance: AS_CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp", "iat", "sub"],
    }));
  } catch {
    return { ok: false, reason: "invalid_token" };
  }
  if (payload.nonce !== undefined) return { ok: false, reason: "id_token" };
  if (payload.purpose !== purpose) return { ok: false, reason: "wrong_purpose" };
  const lifetime = Number(payload.exp) - Number(payload.iat);
  if (!Number.isFinite(lifetime) || lifetime > AS_MAX_LIFETIME_SECONDS) {
    return { ok: false, reason: "lifetime_too_long" };
  }
  if (typeof payload.sub !== "string" || payload.sub === "") {
    return { ok: false, reason: "no_subject" };
  }
  return { ok: true, subject: payload.sub, payload };
}

test("🔴 purpose 글자가 A/S 가 요구하는 것과 같다", () => {
  // 여기가 어긋나면 그 통로만 조용히 401 이 된다. 양쪽을 함께 고치라는 표시다.
  assert.deepEqual({ ...PORTAL_SERVICE_TOKEN_PURPOSES }, { ...AS_PURPOSES });
});

test("우리가 구운 토큰이 A/S 의 검증을 그대로 통과한다", async () => {
  const result = await verifyLikeTheOtherSide(
    await bake(),
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead
  );
  assert.ok(result.ok, "ok" in result ? "" : JSON.stringify(result));
  assert.equal(result.subject, SUBJECT);
});

test("🔴 purpose 가 통로마다 다르다 — 세 값이 서로 겹치지 않는다", () => {
  const values = Object.values(PORTAL_SERVICE_TOKEN_PURPOSES);
  assert.equal(new Set(values).size, values.length, values.join(","));
});

test("🔴 알림을 읽으려고 구운 토큰으로 설정을 고칠 수 없다", async () => {
  const readToken = await bake(PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead);

  // 같은 토큰을 쓰기 통로에 들이밀면 저쪽이 거절한다.
  const asWrite = await verifyLikeTheOtherSide(
    readToken,
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationSettingsWrite
  );
  assert.equal(asWrite.ok, false);
  assert.equal(asWrite.ok === false ? asWrite.reason : "", "wrong_purpose");

  // 설정 읽기 통로에도 마찬가지다 — 셋이 서로 대체되지 않는다.
  const asSettingsRead = await verifyLikeTheOtherSide(
    readToken,
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationSettingsRead
  );
  assert.equal(asSettingsRead.ok, false);
});

test("🔴 설정 읽기용 토큰으로 설정을 저장할 수 없다", async () => {
  const token = await bake(PORTAL_SERVICE_TOKEN_PURPOSES.notificationSettingsRead);
  const result = await verifyLikeTheOtherSide(
    token,
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationSettingsWrite
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : "", "wrong_purpose");
});

test("🔴 nonce 를 싣지 않는다 — 있으면 저쪽이 ID 토큰으로 보고 거절한다", async () => {
  const result = await verifyLikeTheOtherSide(
    await bake(),
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead
  );
  assert.ok(result.ok);
  assert.ok(!("nonce" in result.payload), JSON.stringify(result.payload));
});

test("🔴 exp·iat·sub 이 모두 실린다 — 하나라도 없으면 거절된다", async () => {
  const result = await verifyLikeTheOtherSide(
    await bake(),
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead
  );
  assert.ok(result.ok);
  for (const claim of ["exp", "iat", "sub"] as const) {
    assert.equal(typeof result.payload[claim] !== "undefined", true, claim);
  }
});

test("🔴 수명이 저쪽 상한(600초)보다 넉넉히 짧다", async () => {
  assert.ok(
    PORTAL_SERVICE_TOKEN_TTL_SECONDS < AS_MAX_LIFETIME_SECONDS,
    `${PORTAL_SERVICE_TOKEN_TTL_SECONDS} vs ${AS_MAX_LIFETIME_SECONDS}`
  );
  const result = await verifyLikeTheOtherSide(
    await bake(),
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead
  );
  assert.ok(result.ok);
  assert.equal(
    Number(result.payload.exp) - Number(result.payload.iat),
    PORTAL_SERVICE_TOKEN_TTL_SECONDS
  );
});

test("만료된 토큰은 저쪽이 거절한다", async () => {
  // 수명 + 시계 여유를 한참 넘긴 과거에 구운 토큰.
  const longAgo = Math.floor(Date.now() / 1000) - PORTAL_SERVICE_TOKEN_TTL_SECONDS - 600;
  const result = await verifyLikeTheOtherSide(
    await bake(PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead, { nowSeconds: longAgo }),
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead
  );
  assert.equal(result.ok, false);
});

test("🔴 다른 시스템에 발급된 토큰은 그 시스템에서만 통한다", async () => {
  const forMeters = await bake(PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead, {
    audience: "dss-meters",
  });
  // 계측기에 발급한 토큰을 A/S 에 들이밀면 aud 가 달라 거절된다.
  const atAs = await verifyLikeTheOtherSide(
    forMeters,
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead,
    "rf-service-system"
  );
  assert.equal(atAs.ok, false);
  // 제 주인에게는 통한다.
  const atMeters = await verifyLikeTheOtherSide(
    forMeters,
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead,
    "dss-meters"
  );
  assert.equal(atMeters.ok, true);
});

test("다른 키로 서명한 토큰은 통하지 않는다", async () => {
  const other = await generateKeyPair("RS256", { extractable: true });
  const token = await signPortalServiceToken({
    issuer: ISSUER,
    audience: AUDIENCE,
    subject: SUBJECT,
    purpose: PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead,
    key: other.privateKey,
    kid: "남의키",
  });
  const result = await verifyLikeTheOtherSide(
    token,
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead
  );
  assert.equal(result.ok, false);
});

test("머리말에 RS256 과 kid 가 실린다 — 저쪽 JWKS 가 키를 고를 수 있어야 한다", async () => {
  const header = decodeProtectedHeader(await bake());
  assert.equal(header.alg, "RS256");
  assert.equal(header.kid, "2026-09-01");
});

test("jti 가 매번 다르다", async () => {
  const [a, b] = await Promise.all([bake(), bake()]);
  const first = await verifyLikeTheOtherSide(a, PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead);
  const second = await verifyLikeTheOtherSide(b, PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead);
  assert.ok(first.ok && second.ok);
  assert.notEqual(first.payload.jti, second.payload.jti);
});

test("sub 는 포털 users.id 그대로다 — 저쪽이 이것으로 사람을 되짚는다", async () => {
  const result = await verifyLikeTheOtherSide(
    await bake(PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead, { subject: "다른-사람-id" }),
    PORTAL_SERVICE_TOKEN_PURPOSES.notificationsRead
  );
  assert.ok(result.ok);
  assert.equal(result.subject, "다른-사람-id");
});
