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
         * Re-seeded 2026-08-12 against a measured run: script 223.0 kB, font 95.0 kB,
         * stylesheet 8.6 kB, total 370.2 kB — the previous total ceiling of 370 kB was
         * exceeded by 175 bytes. Roughly 1.2 kB gzip of that growth is the security
         * pass (CSP construction, the stream slot counter, the error reporter); the
         * rest is the Text primitive and the widened project query.
         *
         * Raising a budget is a decision, not a formality: `pnpm size` still gates
         * first-load JS per route at the tighter, unchanged numbers in
         * bundle-budgets.json, and these exist to catch what that cannot.
         */
        "resource-summary:script:size": ["error", { maxNumericValue: 234000 }],
        "resource-summary:stylesheet:size": ["error", { maxNumericValue: 12000 }],
        "resource-summary:font:size": ["error", { maxNumericValue: 100000 }],
        "resource-summary:total:size": ["error", { maxNumericValue: 389000 }],
      },
    },

    upload: { target: "filesystem", outputDir: ".lighthouseci" },
  },
};
