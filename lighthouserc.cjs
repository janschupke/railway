const { existsSync, readFileSync } = require("node:fs");

const APP_PORT = process.env.APP_PORT ?? 3100;
const APP_URL = `http://localhost:${APP_PORT}`;
// Inside .lighthouseci/, which is already ignored whole — the file is a live sealed
// session and does not belong at the repo root, in every build context. See lh-auth.ts.
const COOKIE_FILE = process.env.LH_COOKIE_FILE ?? ".lighthouseci/cookie";

/*
 * Written by scripts/lh-auth.ts, which completes the real OAuth round trip against the
 * fake Railway. Without it the dashboard just redirects to the landing page, and the
 * run would silently measure the same page twice — so its absence is fatal, not a
 * degraded mode.
 */
if (!existsSync(COOKIE_FILE)) {
  throw new Error(
    `${COOKIE_FILE} not found. Run \`pnpm lh:auth\` first (pnpm lighthouse does this for you).`,
  );
}

const cookie = readFileSync(COOKIE_FILE, "utf8").trim();

module.exports = {
  ci: {
    collect: {
      url: [`${APP_URL}/`, `${APP_URL}/dashboard`],
      /*
       * ONE run, ONE Chrome. The default is three, and nothing here needs the extra
       * samples badly enough to justify three browsers competing with the dev machine.
       */
      numberOfRuns: 1,
      settings: {
        preset: "desktop",
        extraHeaders: JSON.stringify({ Cookie: cookie }),
        chromeFlags: "--no-sandbox --headless=new",
        // The SSE stream never closes, so a network-quiet wait would hang until timeout.
        maxWaitForLoad: 45000,
      },
    },

    assert: {
      assertions: {
        /*
         * Accessibility is the hard gate: it is deterministic, and this app makes
         * specific claims about it. Performance is left as a warning on purpose —
         * scores swing by 10+ points on a shared CI runner, and a gate that flakes is a
         * gate everyone learns to ignore. Real size regressions are caught by the
         * resource budgets below and by `pnpm size`, both of which are deterministic.
         */
        "categories:accessibility": ["error", { minScore: 1 }],
        "categories:best-practices": ["error", { minScore: 0.9 }],
        "categories:seo": ["error", { minScore: 0.9 }],
        "categories:performance": ["warn", { minScore: 0.9 }],

        // Layout stability is stable enough to gate on, unlike the composite score.
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.1 }],

        /*
         * Transfer sizes, from a real run of the heaviest page (/dashboard) plus ~5%.
         * These apply to every URL, so they track the worst case — and they cover what
         * `pnpm size` cannot: fonts, CSS and the document itself.
         *
         * Re-seeded 2026-08-15 against a measured /dashboard run: script 252.0 kB,
         * font 94.8 kB, stylesheet 10.2 kB, total 399.2 kB.
         *
         * Script moved from 234 kB. It was seeded on 2026-08-12 against 223.0 kB and
         * then left alone while the route itself grew — the combobox, the
         * image-existence check, the deployment history and the billing split each
         * raised /dashboard's entry in bundle-budgets.json (209 -> 237) and none of
         * them came back here. So it had been failing on its own for several commits,
         * and re-seeding it catches this file up rather than paying for a regression.
         *
         * Total moved from 389 kB, and it is the one number here that is not a
         * measurement of page weight. /dashboard holds the watcher's EventSource open,
         * and a `router.refresh()` it triggers fetches an RSC payload of about 17 kB —
         * which lands inside Lighthouse's trace window or does not, depending on where
         * the poll falls. Two runs of an identical build measured 382.6 kB and
         * 399.2 kB with byte-identical script, font and stylesheet. So this ceiling is
         * seeded above the refreshing case; the three per-type ceilings are the
         * deterministic gates and are what a real regression trips first.
         *
         * Raising a budget is a decision, not a formality: `pnpm size` still gates
         * first-load JS per route at the tighter, unchanged numbers in
         * bundle-budgets.json, and these exist to catch what that cannot.
         */
        "resource-summary:script:size": ["error", { maxNumericValue: 265000 }],
        "resource-summary:stylesheet:size": ["error", { maxNumericValue: 12000 }],
        "resource-summary:font:size": ["error", { maxNumericValue: 100000 }],
        "resource-summary:total:size": ["error", { maxNumericValue: 420000 }],
      },
    },

    upload: { target: "filesystem", outputDir: ".lighthouseci" },
  },
};
