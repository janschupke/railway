import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";
import prettier from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // eslint-config-next enables only a subset of jsx-a11y. This app commits to WCAG AA,
  // so the strict rule set runs and CI treats any warning as a failure.
  //
  // Only the rules are spread, not the whole flat config: eslint-config-next already
  // registers the jsx-a11y plugin, and registering it twice is a hard config error.
  {
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      // Radix primitives forward their own semantics; a wrapping <label> around a
      // Radix control is correct even though the rule cannot see the association.
      "jsx-a11y/label-has-associated-control": [
        "error",
        { assert: "either", depth: 3 },
      ],
    },
  },

  {
    files: ["e2e/**/*.ts", "scripts/**/*.ts"],
    rules: {
      // Fixtures and CLI scripts legitimately log and use Node globals.
      "no-console": "off",
      /*
       * No React here. Playwright's fixture signature is `async ({ page }, use)`,
       * and the rule reads that `use(...)` call as React 19's `use` hook being
       * invoked from a function named `page`.
       */
      "react-hooks/rules-of-hooks": "off",
    },
  },

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),

  // Must stay last: turns off every stylistic rule that would fight Prettier.
  prettier,
]);

export default eslintConfig;
