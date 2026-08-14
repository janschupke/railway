import { defineConfig, devices } from "@playwright/test";

const FIXTURE_PORT = 4010;
const APP_PORT = 3100;

const APP_URL = `http://localhost:${APP_PORT}`;
const FIXTURE_URL = `http://localhost:${FIXTURE_PORT}`;

/**
 * The app runs unmodified and talks to e2e/fixtures/fake-railway instead of Railway,
 * so the real OAuth flow — PKCE, token exchange, refresh rotation — is exercised here.
 *
 * `workers: 1` is deliberate and not negotiable: the fixture holds shared in-memory
 * state and the suite resets it between specs, so parallel workers would race. It also
 * keeps a browser pool from being spawned on developer machines.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // Everything except the one spec that only means anything on a phone.
      testIgnore: /responsive\.spec\.ts/,
    },
    /*
     * One spec at phone width, not the whole suite twice.
     *
     * `workers: 1` is not negotiable (the fixture holds shared state), so a second full
     * project would roughly double CI wall-clock. It would also buy very little: the app
     * declares one `sm:` in all of src/ and adapts by wrapping everywhere else, so there
     * is no viewport-conditional code for a second run to regress. What a phone viewport
     * genuinely proves — nothing overflows sideways, the chip strip wraps rather than
     * clips, the controls stay tappable — is what e2e/responsive.spec.ts asserts.
     */
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /responsive\.spec\.ts/,
    },
  ],

  webServer: [
    {
      command: "pnpm exec tsx e2e/fixtures/fake-railway/server.ts",
      url: `${FIXTURE_URL}/oauth/.well-known/openid-configuration`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      env: { FAKE_RAILWAY_PORT: String(FIXTURE_PORT), RAILWAY_CLIENT_ID: "e2e-client" },
    },
    {
      /*
       * The standalone server, not `next start` — which refuses to serve a build made
       * with `output: "standalone"`. This is the same server.js the deployment runs, so
       * the suite exercises the artefact rather than a second way of starting it, and
       * `pnpm build` has to have run: postbuild copies .next/static into place.
       *
       * Port comes from the environment because server.js takes no arguments.
       */
      command: "node .next/standalone/server.js",
      url: `${APP_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NODE_ENV: "production",
        PORT: String(APP_PORT),
        APP_URL,
        RAILWAY_CLIENT_ID: "e2e-client",
        RAILWAY_CLIENT_SECRET: "e2e-secret",
        SESSION_SECRET: "e2e-session-secret-at-least-32-characters",
        MANAGED_PREFIX: "spun-",
        // The floor the env schema allows. The production default is 15s, which no spec
        // can wait out — and a watcher spec that sleeps that long is a watcher spec
        // nobody runs.
        WATCH_POLL_MS: "1000",
        // Two seconds, for the same reason: the production default is two minutes, and a
        // spec proving the staleness nudge fires cannot wait that out any more than the
        // watcher spec above could wait out fifteen seconds. Twice WATCH_POLL_MS, so a
        // nudge lands on a tick rather than on the first one.
        METRICS_POLL_MS: "2000",
        RAILWAY_ISSUER: FIXTURE_URL,
        RAILWAY_API_URL: `${FIXTURE_URL}/graphql/v2`,
        RAILWAY_WS_URL: `ws://localhost:${FIXTURE_PORT}/graphql/v2`,
        // The stand-in registry, so the image check never reaches a real one.
        REGISTRY_PROBE_URL: FIXTURE_URL,
      },
    },
  ],
});

export { APP_URL, FIXTURE_URL };
