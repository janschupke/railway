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

  /*
   * Appearance belongs to the primitives in src/components/ui. Feature components
   * compose them and must not reach for a raw palette colour, a hex literal, or an
   * arbitrary value pointing at a CSS variable — each of those bypasses the semantic
   * token layer and, with it, the light theme and the contrast test.
   *
   * This is a ratchet: nothing violates it today. It exists so the next component
   * cannot quietly reintroduce the drift.
   */
  {
    files: ["src/**/*.tsx"],
    ignores: ["src/components/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `JSXAttribute[name.name="className"] Literal[value=/(^|[^a-z-])(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|placeholder|caret|accent|shadow)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|grey|zinc|neutral|stone|white|black)(\\/|-[0-9]|\\b)/]`,
          message:
            "Raw palette colour in a feature component. Use a semantic token (bg-surface, text-text-muted, border-danger-border…); palette ramps live in src/app/tokens.css and literals only in src/components/ui.",
        },
        {
          selector: `JSXAttribute[name.name="className"] Literal[value=/#[0-9a-fA-F]{3,8}\\b/]`,
          message:
            "Hex colour in markup. Add a semantic token in src/app/tokens.css and map it in globals.css instead.",
        },
        {
          selector: `JSXAttribute[name.name="className"] Literal[value=/-\\[var\\(--/]`,
          message:
            "Arbitrary value reaching past the Tailwind theme at a CSS variable. Map the token in globals.css and use the generated utility (fill-raised, not fill-[var(--rc-raised)]).",
        },
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
