import assert from "node:assert/strict";
import { test } from "node:test";
import type { JWK } from "jose";
import { toPublicJwk } from "./public-jwk";

// 실제 RSA 개인키 JWK가 갖는 필드 구성.
const PRIVATE_JWK = {
  kty: "RSA",
  n: "public-modulus",
  e: "AQAB",
  d: "PRIVATE-EXPONENT",
  p: "PRIVATE-P",
  q: "PRIVATE-Q",
  dp: "PRIVATE-DP",
  dq: "PRIVATE-DQ",
  qi: "PRIVATE-QI",
  kid: "test-kid",
  alg: "RS256",
  use: "sig",
} as unknown as JWK;

test("공개 필드는 그대로 남는다", () => {
  const result = toPublicJwk(PRIVATE_JWK);
  assert.equal(result.kty, "RSA");
  assert.equal(result.n, "public-modulus");
  assert.equal(result.e, "AQAB");
  assert.equal(result.kid, "test-kid");
  assert.equal(result.alg, "RS256");
  assert.equal(result.use, "sig");
});

test("개인키 필드는 하나도 남지 않는다", () => {
  const result = toPublicJwk(PRIVATE_JWK) as Record<string, unknown>;
  for (const secret of ["d", "p", "q", "dp", "dq", "qi"]) {
    assert.equal(result[secret], undefined, `${secret}가 남아 있음`);
  }
});

test("직렬화한 결과에 개인키 값이 문자열로도 남지 않는다", () => {
  // 필드명만 지우고 값이 다른 곳에 복사되는 실수를 잡는다.
  const json = JSON.stringify(toPublicJwk(PRIVATE_JWK));
  assert.doesNotMatch(json, /PRIVATE-/);
});

test("모르는 필드는 기본적으로 버린다", () => {
  const withUnknown = { ...PRIVATE_JWK, futureSecret: "LEAK" } as unknown as JWK;
  const json = JSON.stringify(toPublicJwk(withUnknown));
  assert.doesNotMatch(json, /LEAK/);
});

test("공개키만 든 JWK는 손실 없이 통과한다", () => {
  const publicOnly = { kty: "RSA", n: "n", e: "AQAB", kid: "k", alg: "RS256", use: "sig" } as JWK;
  assert.deepEqual(toPublicJwk(publicOnly), publicOnly);
});
