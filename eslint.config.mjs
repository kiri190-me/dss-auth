import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 서브모듈로 들어온 별도 저장소(dss-ui)다. 그쪽은 제 eslint 설정으로 스스로
    // 검사한다 — 여기서 또 보면 이 저장소의 규칙으로 남의 코드를 고치게 된다.
    "vendor/dss-ui/**",
  ]),
]);

export default eslintConfig;
