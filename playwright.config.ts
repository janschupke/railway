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

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

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
      command: `pnpm exec next start -p ${APP_PORT}`,
      url: `${APP_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NODE_ENV: "production",
        APP_URL,
        RAILWAY_CLIENT_ID: "e2e-client",
        RAILWAY_CLIENT_SECRET: "e2e-secret",
        SESSION_SECRET: "e2e-session-secret-at-least-32-characters",
        MANAGED_PREFIX: "spun-",
        RAILWAY_ISSUER: FIXTURE_URL,
        RAILWAY_API_URL: `${FIXTURE_URL}/graphql/v2`,
        RAILWAY_WS_URL: `ws://localhost:${FIXTURE_PORT}/graphql/v2`,
      },
    },
  ],
});

export { APP_URL, FIXTURE_URL };
