import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";
import i18next from "eslint-plugin-i18next";
import prettier from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // eslint-config-next enables only a subset of jsx-a11y. This app commits to WCAG AA,
  // so the strict rule set runs and CI treats any warning as a failure.
  //
  // Only the rules are spread, not the whole flat config: eslint-config-next already
  // registers the jsx-a11y plugin, and registering it twice is a hard config error.
  //
  // Scoped to JSX files on purpose: eslint-config-next registers the jsx-a11y plugin
  // only for those, so an unscoped block fails to resolve the moment a plain .cjs or
  // .mjs file enters the project.
  {
    files: ["**/*.{jsx,tsx}"],
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
   * compose them and must not reach for a raw palette colour, a hex literal, an
   * arbitrary value pointing at a CSS variable, or a raw type step — each of those
   * bypasses the semantic token layer and, with it, the light theme, the contrast test
   * and the type scale.
   *
   * This is a ratchet: nothing violates it today. It exists so the next component
   * cannot quietly reintroduce the drift. It has already been reintroduced once —
   * before the Text primitive existed there were four spellings of "heading" across
   * five files, and the two page-level h1s were ten pixels and a weight apart.
   */
  {
    files: ["src/**/*.tsx"],
    ignores: ["src/components/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          /*
           * Tailwind's own type steps. The scale roles (text-body, text-caption…) are
           * deliberately not matched: those come from the tokens and are what a caller
           * should reach for on the rare element a primitive cannot wrap.
           */
          selector: `JSXAttribute[name.name="className"] Literal[value=/(^|\\s)(text-(xs|sm|base|lg|xl|[2-9]xl)|font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)|tracking-(tighter|tight|normal|wide|wider|widest)|leading-\\S+)(\\s|$)/]`,
          message:
            "Raw type step in a feature component. Use <Text variant=…> or <Heading> from src/components/ui/text.tsx; the scale lives in src/app/tokens.css.",
        },
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

  /*
   * Every user-facing string lives in messages/. This is what stops the catalog
   * decaying: without it the next component quietly hardcodes a sentence and nothing
   * notices until someone tries to translate the app.
   *
   * Only rendered text is in scope — the allowlist below covers attributes whose values
   * are identifiers, URLs, or CSS rather than copy.
   */
  {
    files: ["src/**/*.tsx"],
    ignores: ["src/**/*.test.tsx", "src/test/**"],
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": [
        "error",
        {
          mode: "jsx-only",
          "should-validate-template": true,
          message: "Move this string into messages/en.json and read it with t().",
          /*
           * A catalog key is not copy. Without these, `t("submit")` is itself reported
           * as a hardcoded string and the rule argues with its own fix.
           */
          callees: {
            exclude: [
              "^t$",
              "^t\\.rich$",
              "^tCommon$",
              "^useTranslations$",
              "^getTranslations$",
              "^(cn|cva|clsx|twMerge)$",
              // A local error-lookup helper keyed by field name, not copy.
              "^fieldError$",
            ],
          },
          /*
           * Props forwarded as an object (ScrollArea's viewportProps) carry ARIA roles
           * and politeness values — protocol, not prose.
           */
          "object-properties": {
            exclude: ["role", "aria-live", "aria-.*", ".*[Cc]lassName", "tone"],
          },
          "jsx-attributes": {
            exclude: [
              // Styling and identifiers.
              "className",
              "class",
              "href",
              "src",
              "id",
              "key",
              "name",
              "value",
              "data-.*",
              "aria-hidden",
              // Component APIs whose values are enum members, not sentences.
              "type",
              "role",
              "variant",
              "size",
              "tone",
              "shape",
              "side",
              "orientation",
              "position",
              "swipeDirection",
              "autoComplete",
              "labelKey",
              ".*[Cc]lassName",
            ],
          },
          words: { exclude: ["^[^a-zA-Z]*$", "^\\s*$"] },
        },
      ],
    },
  },

  // Lighthouse's config format is CommonJS; it is not application code.
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
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

  /*
   * Session handling must not reach a client bundle: those modules hold the JWE
   * seal/open code, the HKDF derivation and the shape of RailwaySession.
   *
   * `import "server-only"` is the usual guard and is deliberately NOT used on them.
   * Its exports map resolves to a bare `throw` outside the `react-server` condition,
   * and two legitimate callers resolve it that way — `src/proxy.ts`, which runs in the
   * middleware layer, and `scripts/probe-projects.ts`, which runs under plain tsx.
   * Note which modules do carry `server-only` today: exactly the ones the proxy does
   * not import. That is the constraint, not an oversight.
   *
   * So the boundary is enforced from the other side instead — at the only files that
   * could pull it into the browser.
   */
  {
    files: ["src/components/**/*.{ts,tsx}", "src/hooks/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/lib/auth/session",
                "**/lib/auth/refresh",
                "**/lib/auth/server",
              ],
              message:
                "Session handling is server-side. Pass what the component needs as a prop.",
            },
          ],
        },
      ],
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
