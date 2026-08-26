import assert from "node:assert/strict";
import { test } from "node:test";
import { computeS256Challenge, verifyPkceS256 } from "./pkce";
import { randomCodeVerifier } from "@/lib/crypto/random";

// RFC 7636 부록 B가 제시하는 공식 테스트 벡터.
// 우리 구현이 규격과 같은 값을 내는지 확인하는 가장 확실한 방법이다.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("RFC 7636 테스트 벡터와 같은 challenge를 만든다", () => {
  assert.equal(computeS256Challenge(RFC_VERIFIER), RFC_CHALLENGE);
});

test("RFC 테스트 벡터 쌍을 통과시킨다", () => {
  assert.equal(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE), true);
});

test("우리가 만든 verifier도 왕복이 맞는다", () => {
  for (let i = 0; i < 5; i += 1) {
    const verifier = randomCodeVerifier();
    assert.equal(verifyPkceS256(verifier, computeS256Challenge(verifier)), true);
  }
});

test("틀린 verifier는 거절한다", () => {
  assert.equal(verifyPkceS256("a".repeat(43), RFC_CHALLENGE), false);
});

test("길이가 규격을 벗어난 verifier는 거절한다", () => {
  // 42자(하한 43 미만) — 형식 검사를 생략하면 짧은 verifier로
  // 무차별 대입이 현실적이 된다.
  const short = "a".repeat(42);
  assert.equal(verifyPkceS256(short, computeS256Challenge(short)), false);

  // 129자(상한 128 초과)
  const long = "a".repeat(129);
  assert.equal(verifyPkceS256(long, computeS256Challenge(long)), false);
});

test("허용되지 않은 문자가 든 verifier는 거절한다", () => {
  // RFC가 허용하는 문자는 [A-Za-z0-9-._~] 뿐이다.
  for (const bad of ["+", "/", "=", " ", "가", "%20"]) {
    const verifier = bad + "a".repeat(50);
    assert.equal(
      verifyPkceS256(verifier, computeS256Challenge(verifier)),
      false,
      `문자: ${bad}`
    );
  }
});

test("challenge가 비었거나 길이가 다르면 예외 없이 false", () => {
  assert.equal(verifyPkceS256(RFC_VERIFIER, ""), false);
  assert.equal(verifyPkceS256(RFC_VERIFIER, "짧음"), false);
  assert.equal(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE + "x"), false);
});

test("verifier가 비어도 예외 없이 false", () => {
  assert.equal(verifyPkceS256("", RFC_CHALLENGE), false);
});
