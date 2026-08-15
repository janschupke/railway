import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = {
  "@": path.resolve(import.meta.dirname, "src"),
  // `server-only` throws by design outside a React Server Component graph.
  // Tests exercise those modules directly, so it is stubbed out here.
  "server-only": path.resolve(import.meta.dirname, "src/test/noop.ts"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
          setupFiles: ["src/test/setup.ts", "src/test/setup-intl.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "component",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          /*
           * setup-intl is here too, so a Server Component that reads copy through
           * `getTranslations` can be rendered by awaiting it. Without it the async
           * components — the header, the footer, the container section — were only
           * ever exercised end-to-end. It is additive: setup-dom mocks `next-intl`
           * for client components, setup-intl mocks `next-intl/server`, and the two
           * cover different modules.
           */
          setupFiles: [
            "src/test/setup.ts",
            "src/test/setup-dom.ts",
            "src/test/setup-intl.ts",
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.integration.test.ts"],
          setupFiles: ["src/test/setup.ts", "src/test/setup-intl.ts"],
        },
      },
      {
        /*
         * ESLint's own RuleTester, over the rules in eslint-rules/.
         *
         * Its own project because nothing else about these files matches the three above:
         * they are `.mjs`, they are outside `src/`, and they must not load the setup files
         * — log-capture and the next-intl mocks have nothing to say about a linter.
         *
         * Outside `src/` is also why they carry no coverage obligation: `coverage.include`
         * is `src/**`, so a rule's branches do not move the gate. What proves a rule works
         * is a RuleTester case per branch, which is what these files are, and the
         * regression check that the invariant it inherited is still caught.
         */
        test: {
          name: "lint-rules",
          environment: "node",
          include: ["eslint-rules/**/*.test.mjs"],
        },
      },
    ],

    coverage: {
      provider: "v8",
      /*
       * `json-summary` is here for the thresholds below, which are counts rather than
       * percentages and therefore need a number a person can read off the run. `text` is
       * for the terminal, `lcov` for the CI artefact, `html` for reading a file's misses.
       */
      reporter: ["text", "lcov", "html", "json-summary"],
      include: ["src/**"],
      exclude: [
        "src/test/**",
        "src/**/*.d.ts",
        "src/**/*.test.*",
        /*
         * Railway's schema, which lives beside the client that queries it. `all` reports
         * every file under `include`, and the v8 provider hands each one to a JavaScript
         * parser — so 6 900 lines of SDL arrive as a RolldownError on every coverage run.
         * It is data, not code; `src/lib/railway/graphql.generated.ts` is the code generated
         * from it and stays inside the gate, where it costs nothing because it is types only.
         */
        "src/**/*.graphql",
        /*
         * Framework shells: these are React Server Components and route boundaries
         * whose behaviour is composition. They are covered end-to-end by Playwright
         * (e2e/), which does not feed this number — counting them here would either
         * inflate the figure or invite render tests that assert nothing.
         *
         * Everything with logic in it — lib, hooks, components, Server Actions, data
         * loaders and API route handlers — is inside the gate.
         */
        "src/app/**/layout.tsx",
        "src/app/**/page.tsx",
        "src/app/**/loading.tsx",
        "src/app/**/error.tsx",
        "src/app/**/not-found.tsx",
      ],
      /*
       * A ratchet rather than a floor.
       *
       * These were 80 against an actual of ~94, which is eight to fourteen points of
       * slack — a change could delete a third of the branch coverage and still pass, so
       * the gate documented an intention rather than defending one. Set just under the
       * measured figures instead, which is what makes a drop a failure rather than a
       * statistic.
       *
       * Raise these when the real number rises. Lowering one is the same class of edit
       * as raising a bundle budget: allowed, and it should be argued for in the commit.
       */
      thresholds: {
        /*
         * Counts, not percentages, and the sign is what selects between them: vitest reads
         * a positive number as "at least X% covered" and a negative one as "at most X
         * uncovered".
         *
         * A percentage measures the wrong thing for a ratchet. Its denominator moves with
         * the code, so the gate changes meaning when nothing about the testing has: adding
         * a well-tested module can *fail* a percentage that a smaller, worse-tested tree
         * passed, and deleting code silently loosens it. Both happened here in miniature —
         * the global lines gate had about thirteen uncovered lines of headroom, so a new
         * forty-line module with twenty-five covered lines was a red build regardless of
         * how well it was tested.
         *
         * A count says what the ratchet has always meant: this many lines in the app are
         * not exercised, and the number may go down. It is also stable across a refactor
         * that only moves code between files, which is the next thing happening to this
         * repository.
         *
         * Measured, at the commit that introduced these: 68 lines, 247 branches, 21
         * functions, 137 statements. Each threshold carries roughly a tenth of that as
         * headroom — the same margin the percentages carried, expressed in the unit
         * anybody reading a failure will see.
         */
        lines: -75,
        branches: -265,
        functions: -25,
        statements: -150,

        /*
         * Per-directory, because a global aggregate cannot see a single file at zero.
         *
         * Five modules sat at 0% while the headline number read 94 — including
         * lib/railway/subscribe.ts, the upstream WebSocket, which security.md singles
         * out precisely because a `ws` failure carries the resolved upstream address.
         * The aggregate is not the wrong metric; it is the wrong resolution.
         *
         * Rejected: `perFile: true`. It fails on legitimately thin modules — i18n/config.ts
         * is one exported constant — and its only available remedy is widening the
         * exclude list, which testing.md forbids for exactly this reason. Directory
         * floors put the pressure where the logic is without inviting that.
         */
        // Measured: 18 lines, 66 branches, 4 functions, 36 statements.
        "src/lib/**": { lines: -22, branches: -73, functions: -6, statements: -42 },
        /*
         * The one file with a threshold of its own, and it earns it by name.
         *
         * `subscribe.ts` is the module the paragraph above cites as the reason directory
         * floors exist — and it sat at 33% functions afterwards regardless, because
         * `src/lib/**` aggregates 40-odd files and a 15-line module cannot move that mean.
         * The remedy was chosen for this file and then did not defend it.
         *
         * It is at 100% now and pinned there. Small enough that the ratchet costs nothing,
         * and the one place in the app that puts a bearer token on an upgrade request, so
         * the next uncovered line here is worth a red build on its own.
         */
        "src/lib/railway/subscribe.ts": {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        // Measured: 2 lines, 6 branches, 1 function, 4 statements.
        "src/hooks/**": { lines: -4, branches: -9, functions: -3, statements: -7 },
        /*
         * The rail yard. It gets a floor of its own for the same reason lib and hooks do:
         * it is the largest body of logic in the app outside those two, and a global
         * aggregate cannot see one of its ten modules fall to nothing.
         *
         * Branches sits lower than elsewhere on purpose. Most of the misses are the
         * legibility guards in the renderer — "skip this part if it would be under a
         * pixel" — which need a viewport scale per branch to reach, and the assertion
         * that actually matters there is the measured one in render.test.ts rather than
         * having visited both sides of every size check.
         *
         * Lower, though, still means just under what is measured. It sat at 85 against a
         * measured 87.12 — a round number with two points of slack, which is what the
         * paragraph at the top of this block and testing.md both forbid: it is room for
         * tests to be deleted without a red build, which is the only thing a ratchet is
         * for. Same correction for src/hooks/**, at 91 against 94.29.
         */
        // Measured: 6 lines, 67 branches, 1 function, 34 statements.
        "src/features/**": { lines: -9, branches: -74, functions: -3, statements: -40 },
        /*
         * The directory the ratchet above was missing, and the one it could least afford to.
         *
         * Measured 95.65 / 89.94 / 95.74 / 96.70 — under the global gate on all four axes,
         * not merely under the other floors. It passed anyway, because src/features (99.40
         * statements) and src/hooks (99.07) carry the aggregate: exactly the arithmetic the
         * per-directory floors were introduced to defeat, reproduced one directory over
         * from where it was first found.
         *
         * That is worth stating plainly, because the omission did not look like one. Three
         * floors were written, the largest directory of hand-written UI was not among them,
         * and nothing in the config or the rules distinguished "deliberately aggregated"
         * from "forgotten". A floor per directory is only a ratchet if the set is complete.
         *
         * Set a point under each measurement, the same margin the others carry. Branches
         * sits lowest for the reason it does everywhere in this app: the untaken sides are
         * mostly optional-prop and empty-collection guards on primitives, which need a
         * caller per branch to reach and assert nothing anyone relies on.
         */
        // Measured: 31 lines, 83 branches, 15 functions, 46 statements.
        "src/components/**": {
          lines: -36,
          branches: -91,
          functions: -18,
          statements: -53,
        },
      },
    },
  },
});
