import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";
import i18next from "eslint-plugin-i18next";
import prettier from "eslint-config-prettier";

/**
 * The four appearance bans, as (pattern, message) pairs.
 *
 * Defined once and expanded into two selectors each, because the node type matters:
 * `Literal` covers `className="text-sm"` and `TemplateElement` covers
 * `` className={`text-sm ${x}`} ``. Only Literal was matched, so a template literal
 * escaped all four — the one in the tree today is benign, which is exactly how this
 * would have gone unnoticed until it was not.
 */
const APPEARANCE_BANS = [
  {
    /*
     * Tailwind's own type steps. The scale roles (text-body, text-caption…) are
     * deliberately not matched: those come from the tokens and are what a caller
     * should reach for on the rare element a primitive cannot wrap.
     */
    pattern: `(^|\\s)(text-(xs|sm|base|lg|xl|[2-9]xl)|font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)|tracking-(tighter|tight|normal|wide|wider|widest)|leading-\\S+)(\\s|$)`,
    message:
      "Raw type step in a feature component. Use <Text variant=…> or <Heading> from src/components/ui/text.tsx; the scale lives in src/app/tokens.css.",
  },
  {
    pattern: `(^|[^a-z-])(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|placeholder|caret|accent|shadow)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|grey|zinc|neutral|stone|white|black)(\\/|-[0-9]|\\b)`,
    message:
      "Raw palette colour in a feature component. Use a semantic token (bg-surface, text-text-muted, border-danger-border…); palette ramps live in src/app/tokens.css and literals only in src/components/ui.",
  },
  {
    pattern: `#[0-9a-fA-F]{3,8}\\b`,
    message:
      "Hex colour in markup. Add a semantic token in src/app/tokens.css and map it in globals.css instead.",
  },
  {
    pattern: `-\\[var\\(--`,
    message:
      "Arbitrary value reaching past the Tailwind theme at a CSS variable. Map the token in globals.css and use the generated utility (fill-raised, not fill-[var(--rc-raised)]).",
  },
];

/**
 * security.md: "no NEXT_PUBLIC_* exists, and none should."
 *
 * NEXT_PUBLIC_ is Next's opt-in for inlining a value into the browser bundle — the one
 * mechanism in this app capable of turning a server-side secret into a public one by
 * rename alone. There are none today; this is what keeps that true. Both spellings are
 * covered, because banning only the dot form is an instruction on how to evade it.
 */
const PUBLIC_ENV_MESSAGE =
  "NEXT_PUBLIC_* inlines a value into the browser bundle. This app has no client-side configuration by design — see security.md. Pass what a component needs as a prop.";

const publicEnvBans = [
  {
    selector: `MemberExpression[object.object.name="process"][object.property.name="env"][property.name=/^NEXT_PUBLIC_/]`,
    message: PUBLIC_ENV_MESSAGE,
  },
  {
    selector: `MemberExpression[object.object.name="process"][object.property.name="env"] > Literal[value=/^NEXT_PUBLIC_/]`,
    message: PUBLIC_ENV_MESSAGE,
  },
];

const appearanceBans = APPEARANCE_BANS.flatMap(({ pattern, message }) =>
  ["Literal[value=", "TemplateElement[value.raw="].map((node) => ({
    selector: `JSXAttribute[name.name="className"] ${node}/${pattern}/]`,
    message,
  })),
);

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
    /*
     * The publicEnvBans are repeated here rather than left to the block below.
     *
     * Flat config REPLACES a rule's options when a later block names the same rule for
     * the same file, so a second `no-restricted-syntax` matching *.tsx would silently
     * switch the appearance bans off — a config change that turns four ratchets into
     * nothing while lint still passes.
     */
    files: ["src/**/*.tsx"],
    ignores: ["src/components/ui/**"],
    rules: {
      "no-restricted-syntax": ["error", ...appearanceBans, ...publicEnvBans],
    },
  },

  {
    // Everything the block above does not cover: .ts files, and src/components/ui.
    files: [
      "src/**/*.ts",
      "src/components/ui/**/*.tsx",
      "scripts/**/*.ts",
      "e2e/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...publicEnvBans],
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
              /*
               * A second namespace in the same file is named `tCommon`, `tStates`,
               * `tFilters` — `t` followed by the namespace. Matching the shape rather
               * than listing each one keeps this from growing a line per component.
               */
              "^t[A-Z]\\w*$",
              "^useTranslations$",
              "^getTranslations$",
              "^(cn|cva|clsx|twMerge)$",
              // A local error-lookup helper keyed by field name, not copy.
              "^fieldError$",
              // A CSS media query is a selector, and the app has to read this one in JS:
              // scrollTo's `behavior` overrides the CSS property the global rule sets.
              "^window\\.matchMedia$",
            ],
          },
          /*
           * Props forwarded as an object (ScrollArea's viewportProps) carry ARIA roles
           * and politeness values — protocol, not prose.
           */
          "object-properties": {
            // `behavior` is scrollTo's own enum — "auto" or "smooth", never prose.
            exclude: [
              "role",
              "aria-live",
              "aria-.*",
              ".*[Cc]lassName",
              "tone",
              "behavior",
            ],
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
              /*
               * aria-busy takes "true"/"false" — a token the platform defines, not copy.
               * Every other aria-* attribute stays checked, because the ones that carry
               * text (aria-label, aria-description) are exactly the strings a translator
               * needs and the ones most easily forgotten.
               */
              "aria-busy",
              // Component APIs whose values are enum members, not sentences.
              "type",
              "role",
              "variant",
              "size",
              "tone",
              "shape",
              /*
               * PageMain and BarInner's cva variants. Same class as `variant` and `size`
               * above: consumed by class-variance-authority to select a recipe, never
               * rendered, and a translator has nothing to do with "narrow" or "hero".
               */
              "width",
              "layout",
              "pad",
              "side",
              "align",
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
    // Fixtures and CLI scripts legitimately log and use Node globals.
    rules: { "no-console": "off" },
  },

  {
    /*
     * e2e only. The exemption exists for Playwright's fixture signature — `async ({
     * page }, use)`, where the rule reads that `use(...)` call as React 19's `use` hook
     * being invoked from a function named `page` — and no script has one. It used to
     * cover scripts/ as well, which turned off a real rule across five files for a
     * reason none of them could ever hit.
     */
    files: ["e2e/**/*.ts"],
    rules: { "react-hooks/rules-of-hooks": "off" },
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
            {
              // Same reasoning one layer over: the logger writes to the server's stdout,
              // which a browser does not have. A client component importing it would
              // bundle pino and log into a void.
              group: ["**/lib/logger", "**/lib/log/*"],
              message:
                "The logger writes to the server's stdout. Client-side failures reach the server through instrumentation.ts.",
            },
          ],
        },
      ],
    },
  },

  /*
   * A structured record is only worth having if nothing bypasses it. A stray
   * `console.error(error)` is also how the OAuth token leak got in — `error.cause` is
   * where oauth4webapi puts a live access token — so this rule is a security ratchet as
   * much as a formatting one. `eslint-config-next` does not enable it, so this is
   * additive; the e2e/scripts block above keeps its exemption, because those print
   * aligned tables for a person at a terminal and JSON would be a regression.
   *
   * Exactly one inline disable exists, in src/app/dashboard/error.tsx, which runs in the
   * browser.
   */
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: { "no-console": "error" },
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
