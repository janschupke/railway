import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";
import i18next from "eslint-plugin-i18next";
import prettier from "eslint-config-prettier";
import local from "./eslint-rules/index.mjs";

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
    scope: "anywhere",
    message:
      "Raw type step in a feature component. Use <Text variant=…> or <Heading> from src/components/ui/text.tsx; the scale lives in src/app/tokens.css.",
  },
  {
    pattern: `(^|[^a-z-])(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|placeholder|caret|accent|shadow)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|grey|zinc|neutral|stone|white|black)(\\/|-[0-9]|\\b)`,
    scope: "anywhere",
    message:
      "Raw palette colour in a feature component. Use a semantic token (bg-surface, text-text-muted, border-danger-border…); palette ramps live in src/app/tokens.css and literals only in src/components/ui.",
  },
  {
    pattern: `#[0-9a-fA-F]{3,8}\\b`,
    scope: "style",
    message:
      "Hex colour in markup. Add a semantic token in src/app/tokens.css and map it in globals.css instead.",
  },
  {
    pattern: `-\\[var\\(--`,
    scope: "className",
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

/**
 * Both node types, because only `Literal` was matched once and a template literal escaped
 * all four — `` className={`text-sm ${x}`} `` is a `TemplateElement`.
 */
const STRING_NODES = ["Literal[value=", "TemplateElement[value.raw="];

/**
 * Where each ban has to look, which is not the same question for all four.
 *
 * `className` was the only ancestor any of them matched, and that left three holes. A
 * literal assigned to a variable and used as a class — `const ROW = "text-sm text-gray-400"`
 * — matched nothing. `.ts` files were outside the block entirely, so a `cva` recipe or a
 * class lookup table could carry anything. And `style={{ color: "#6c3fe7" }}` is not a
 * `className` attribute, so the hex ban never saw the one place hex is actually spelled.
 *
 * So the reach is now per pattern rather than uniform:
 *
 * - **anywhere** — the type-step and palette patterns. These match Tailwind class shapes
 *   and nothing else plausible, so they are safe to ban on any string in the file and that
 *   is what closes the variable and `.ts` holes.
 * - **style** — the hex pattern, on `style={{…}}`. Deliberately not "anywhere": `#` plus
 *   hex digits is also an id selector, a URL fragment and a git sha, and a ban that fires
 *   on those is a ban people learn to disable.
 * - **className** — the `-[var(--…)]` pattern, which is a Tailwind arbitrary value and
 *   cannot appear anywhere else by construction.
 */
const BAN_ANCESTORS = {
  anywhere: [""],
  className: [`JSXAttribute[name.name="className"] `],
  style: [`JSXAttribute[name.name="style"] `],
};

const appearanceBans = APPEARANCE_BANS.flatMap(({ pattern, scope, message }) =>
  BAN_ANCESTORS[scope].flatMap((ancestor) =>
    STRING_NODES.map((node) => ({
      selector: `${ancestor}${node}/${pattern}/]`,
      message,
    })),
  ),
);

/**
 * ADR-13's consequence: a route handler may name neither `request.url` nor `APP_URL`.
 *
 * `request.url` first, because it is measured. Behind Railway's proxy it is the
 * *internal* origin, `http://localhost:<PORT>` — Next's standalone server builds it from
 * the socket, not from the Host header — so a redirect built on it carries the container's
 * own address to the browser. `APP_URL` is the fallback for a request with no usable Host,
 * not the origin this request arrived at, so using it answers one domain's request with
 * another domain's address. Both go through `requestOrigin(request)`.
 *
 * These were src/app/redirect-origin.test.ts, which matched
 * `/new URL\([^)]*?,\s*request\.(url|nextUrl)\s*\)/`. The selector is strictly stronger:
 * `[^)]*?` stops at the first `)`, so `new URL(join(a, b), request.url)` — a nested call
 * in the first argument — matched nothing.
 */
const routeOriginBans = [
  {
    selector: `NewExpression[callee.name="URL"] > MemberExpression[property.name=/^(url|nextUrl)$/]`,
    message:
      "This builds a URL from request.url. Behind a proxy that is the container's own origin, and a route handler's redirect carries it to the browser. Use requestOrigin(request) as the base.",
  },
  {
    selector: `Identifier[name="APP_URL"]`,
    message:
      "APP_URL is the fallback for a request with no usable Host, not the origin this request arrived at — using it answers one domain's request with another domain's address. Use requestOrigin(request).",
  },
];

/**
 * Session handling and the logger are server-side, wherever a client component lives.
 *
 * Held in a constant because two blocks need it: flat config REPLACES a rule's options
 * when a later block names the same rule for the same file, so the block that adds the
 * mutation ban below has to re-supply these or it switches them off for
 * src/components/**.
 */
const serverOnlyImportBans = [
  {
    group: ["**/lib/auth/session", "**/lib/auth/refresh", "**/lib/auth/server"],
    message:
      "Session handling is server-side. Pass what the component needs as a prop.",
  },
  {
    // Same reasoning one layer over: the logger writes to the server's stdout,
    // which a browser does not have. A client component importing it would
    // bundle pino and log into a void.
    group: ["**/lib/logger", "**/lib/log/*"],
    message:
      "The logger writes to the server's stdout, which a browser has no access to. There is no client-to-server error channel in this app — surface the failure to the user instead.",
  },
];

/**
 * The mutations that change infrastructure may be imported only by the write lane.
 *
 * This is half of what src/lib/railway/mutation-callsites.test.ts asserted — "reachable
 * from app/dashboard/actions.ts and its declaring module, and nowhere else" — expressed
 * as an import ban so a new caller hears about it while typing rather than in CI.
 *
 * The other half is `local/mutation-inside-ownership-guard`, which requires each call to
 * sit inside the ownership guard. Neither is sufficient alone: this one would allow the
 * write lane to call a mutation on an unchecked id, and that one would allow any module
 * to do so as long as it opened a guard. Together they say what the rule has always
 * meant.
 *
 * **The group is the directory, not one file, and that is load-bearing.** It used to name
 * `**\/lib/railway/api`, which was true only for as long as every mutation lived in that one
 * module — splitting it into siblings would have disarmed the rule for each name that moved,
 * silently, with `pnpm lint` still green. Keying on the directory is strictly stronger: a
 * mutation added to a module that does not exist yet is covered by default, and there is no
 * longer a path edit that can turn this off without deleting it.
 */
const mutationImportBan = {
  group: ["**/lib/railway/*"],
  importNames: [
    "createContainer",
    "updateContainer",
    "destroyContainer",
    "deleteVolume",
    "stopDeployment",
    "restartDeployment",
    "rollbackDeployment",
    "deployService",
    "createServiceDomain",
  ],
  message:
    "This mutation changes infrastructure and belongs to the write lane — src/app/dashboard/** — where every call sits inside withManagedContainer and ownership is re-derived from Railway's own response. A read belongs in data.ts; a new write belongs in a Server Action.",
};

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
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/components/ui/**",
      // Decoration, and the only place in src/ that legitimately names colours: the
      // canvas has no CSS to inherit them from. See architecture.md.
      "src/features/**",
      "src/**/*.test.{ts,tsx}",
      "src/test/**",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...appearanceBans, ...publicEnvBans],
    },
  },

  {
    // Everything the block above does not cover. The appearance bans do not apply here;
    // NEXT_PUBLIC_ still does, everywhere, without exception.
    files: [
      "src/components/ui/**/*.{ts,tsx}",
      "src/features/**/*.{ts,tsx}",
      "src/**/*.test.{ts,tsx}",
      "src/test/**/*.{ts,tsx}",
      "scripts/**/*.ts",
      "e2e/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...publicEnvBans],
    },
  },

  /*
   * Route handlers, which are inside the first block's `files` and therefore have to
   * carry its bans forward as well as their own. Three spreads rather than one is the
   * shape flat config forces: naming `no-restricted-syntax` again for these files
   * REPLACES the options above, so anything omitted here is switched off for every
   * route.ts in the app while lint still passes.
   */
  {
    files: ["src/app/**/route.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...appearanceBans,
        ...publicEnvBans,
        ...routeOriginBans,
      ],
    },
  },

  /*
   * The rules this repo needs and no linter ships. See eslint-rules/index.mjs.
   *
   * Scoped to all of src/ rather than to a directory, because two of the four select
   * their own subjects: a client component is one whose first statement is the directive,
   * and a Server Action is an export of a file whose first statement is the other
   * directive. Path is the wrong axis for both, which is the whole reason they are rules
   * with bodies rather than `files` globs.
   *
   * The fourth needs the whole tree for the opposite reason: a form element is a form
   * element wherever it is written, and the day one appears outside src/components is
   * exactly the day nobody remembers this rule exists.
   */
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/test/**"],
    plugins: { local },
    rules: {
      "local/no-server-imports-in-client": [
        "error",
        {
          modules: [
            "lib/auth/session",
            "lib/auth/refresh",
            "lib/auth/server",
            "lib/logger",
          ],
          directories: ["lib/log"],
          messages: {
            "lib/auth/session":
              "Session handling is server-side. Pass what the component needs as a prop.",
            "lib/auth/refresh":
              "Session handling is server-side. Pass what the component needs as a prop.",
            "lib/auth/server":
              "Session handling is server-side. Pass what the component needs as a prop.",
            "lib/logger":
              "The logger writes to the server's stdout, which a browser has no access to. There is no client-to-server error channel in this app — surface the failure to the user instead.",
          },
        },
      ],
      "local/no-cookie-jar-delete": "error",
      "local/no-function-form-action": "error",
      "local/action-scope-label": "error",
    },
  },

  /*
   * The write lane. `withManagedContainer` re-derives ownership from Railway's own
   * response, and every mutation has to be inside the callback it hands the target to —
   * see the rule for what the byte-offset test this replaces could and could not say.
   */
  {
    files: ["src/app/dashboard/**/*.ts"],
    ignores: ["src/app/dashboard/**/*.test.ts"],
    plugins: { local },
    rules: {
      "local/mutation-inside-ownership-guard": [
        "error",
        {
          mutations: [
            "destroyContainer",
            "deleteVolume",
            "stopDeployment",
            "restartDeployment",
            /*
             * The one mutation whose *argument* the browser chose. Being inside the guard
             * is necessary here and not sufficient — `rollback` also has to resolve the
             * posted deployment id against the service's own list, which no rule can see.
             * Its docblock is where that obligation is written down.
             */
            "rollbackDeployment",
            "updateContainer",
          ],
          guard: "withManagedContainer",
          /*
           * Takes an already-resolved target and issues two mutations, so its body is
           * legitimately outside the callback — and calls to it are checked as mutations
           * in their own right. Adding a name here moves the obligation, never removes it.
           */
          guardedHelpers: ["destroyManagedContainer"],
          /*
           * The second entry point, and the batch's. `destroyMany` reads the container
           * list once and resolves each id against it in a loop rather than opening a
           * callback per service. What makes that safe is not lexical position but the
           * type: `ManagedResolution` is a discriminated union, so `.target` cannot be
           * read without narrowing on `managed`, and the compiler enforces it.
           */
          resolvers: ["resolveManagedTarget"],
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
               * ARIA attributes whose values come from a closed set the platform
               * defines, not from copy: "true"/"false", "polite"/"assertive".
               *
               * Only reachable on a *component* — the rule does not flag these on a bare
               * DOM element — so they surfaced the moment a live region became a
               * primitive rather than three inline copies. Every other aria-* stays
               * checked, because the ones that carry text (aria-label,
               * aria-description) are exactly the strings a translator needs and the
               * ones most easily forgotten.
               */
              "aria-busy",
              "aria-live",
              "aria-atomic",
              // Polymorphic element selector: "p" is a tag name, not a sentence.
              "as",
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
              // Card's elevation step, for the same reason.
              "elevation",
              "side",
              "align",
              "orientation",
              "position",
              "swipeDirection",
              "autoComplete",
              /*
               * Same class as `autoComplete` above, and for the same reason: a closed set
               * the HTML spec defines — "numeric", "tel", "decimal" — read by the browser
               * to choose a soft keyboard and rendered nowhere. The spin-up form's port
               * field is the first attribute of its kind in this codebase; a translator
               * has nothing to do with "numeric".
               */
              "inputMode",
              "labelKey",
              /*
               * KeyValueEditor's FormData field names. Same class as `name` above — they
               * become the `name` attribute on the rendered inputs, and the server reads
               * them back with formData.getAll(). A translator has nothing to do with
               * "variableKey".
               */
              "nameFieldName",
              "valueFieldName",
              /*
               * CreateNameDialog's field name, which is an `ActionField` member — the same
               * closed set `variant` and `size` come from. It is both the rendered input's
               * `name` and the key the Server Action attributes an error to, and it is
               * never shown to anyone.
               */
              "field",
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
    /*
     * src/features/** is here for the same reason as the other two: it holds client
     * components and their hooks, so it is one of the places an import could put the
     * session or pino into a browser bundle. A new top-level directory does not inherit
     * this by being under src/ — the rule selects by path, and adding the directory
     * without adding it here would have opened exactly the hole the rule exists to shut.
     */
    files: [
      "src/components/**/*.{ts,tsx}",
      "src/hooks/**/*.{ts,tsx}",
      "src/features/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [...serverOnlyImportBans, mutationImportBan] },
      ],
    },
  },

  /*
   * The mutation ban, everywhere else under src/.
   *
   * Two blocks rather than one because the block above already names
   * `no-restricted-imports` for src/components, src/hooks and src/features, and flat
   * config replaces rather than merges — so this one deliberately does not match those
   * three, and they get the mutation ban from the composed list above instead.
   *
   * `src/app/dashboard/**` is the write lane and is exempt from the import ban by design;
   * what constrains it is `local/mutation-inside-ownership-guard`. `src/lib/railway/**`
   * is where the mutations are declared, and a declaration is not an import.
   */
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/components/**",
      "src/hooks/**",
      "src/features/**",
      "src/app/dashboard/**",
      "src/lib/railway/**",
      "src/**/*.test.{ts,tsx}",
      "src/test/**",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [mutationImportBan] }],
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

  /*
   * `noUncheckedIndexedAccess` is on, and workflow.md says outright: "An index read is
   * `T | undefined` … Narrow it; do not `!` it away." Nothing enforced that. The compiler
   * option was switched on globally and then switched back off, locally, forty-one times —
   * silently, because `eslint-config-next` ships only `no-extra-non-null-assertion` and
   * `no-non-null-asserted-optional-chain`, neither of which is this rule.
   *
   * What turning it on found was not a live bug — every assertion outside tests was in
   * fact safe. What it found was safety held at a distance: a region mapper whose null
   * filter and whose `id!` sat four lines and one `.map()` apart, a combobox asserting an
   * index that a clamp fifty lines above made valid, and two `split()[0]!` reads standing
   * in for a destructuring default. Each was correct and none of them said why within
   * sight of itself, which is the failure mode `noUncheckedIndexedAccess` exists to catch
   * and which nothing was enforcing.
   *
   * Five remain in `src/lib` under four inline disables, each naming the loop bound or the
   * refinement that makes it safe. An inline disable is the point: it is greppable, it
   * carries a reason, and adding one is a visible decision rather than a character.
   * Everything else in the non-test tree is narrowed, so the rule starts from zero.
   *
   * Tests are exempt, which is a smaller concession than the count suggests: all 114 of
   * the assertions this rule found outside `features/` were in `*.test.*`, indexing a
   * fixture the test constructed three lines earlier. The rule exists because an assertion
   * on data from outside makes a wrong assumption *ship*; in a test a wrong one fails the
   * test, loudly, which is the outcome the rule is trying to buy. Rewriting them would be
   * a hundred narrowing branches guarding states the fixture makes impossible.
   *
   * `src/features/**` is exempt, and the boundary is drawn where it is on purpose. Not
   * "geometry is fiddly" — twenty-eight assertions would be twenty-eight disables and the
   * rule would read as bureaucracy. The reason is that the rail yard is decoration: one
   * consumer in `src/app/page.tsx`, and no import of `lib/railway/**`, `lib/auth/**`,
   * `fetch` or `EventSource` anywhere under it. Nothing a caller supplied reaches those
   * arrays — the renderer indexes structures it built two lines earlier from constants in
   * its own `config.ts` — so an index assumption there cannot be wrong about untrusted
   * input, which is the class of defect this rule is for. If anything under `features/`
   * ever reads Railway data, this exemption goes with it.
   */
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/features/**", "src/**/*.test.{ts,tsx}", "src/test/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "error" },
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
