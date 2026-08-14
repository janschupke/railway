/**
 * Starts the fake Railway and a production Next server against it, then waits until
 * both answer.
 *
 * Shared by Playwright's `webServer` config and Lighthouse's `startServerCommand` so
 * the two cannot drift into measuring different environments. Kill it with Ctrl-C or a
 * SIGTERM; both children go with it.
 */

import { spawn, type ChildProcess } from "node:child_process";

const FIXTURE_PORT = Number(process.env.FAKE_RAILWAY_PORT ?? 4010);
const APP_PORT = Number(process.env.APP_PORT ?? 3100);
const FIXTURE_URL = `http://localhost:${FIXTURE_PORT}`;
const APP_URL = `http://localhost:${APP_PORT}`;

const children: ChildProcess[] = [];

function start(command: string, args: string[], env: Record<string, string>) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`${command} ${args.join(" ")} exited with ${code}`);
      shutdown(code);
    }
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitFor(url: string, label: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`${label} did not become ready within ${timeoutMs}ms`);
  shutdown(1);
}

start("pnpm", ["exec", "tsx", "e2e/fixtures/fake-railway/server.ts"], {
  FAKE_RAILWAY_PORT: String(FIXTURE_PORT),
  RAILWAY_CLIENT_ID: "e2e-client",
});

/*
 * The standalone server, not `next start` — which refuses to serve a build made with
 * `output: "standalone"`. It is the same server.js the deployment runs, and it takes no
 * arguments, so the port arrives through the environment. `pnpm build` has to have run:
 * postbuild is what copies .next/static into the standalone directory, and without it
 * every page answers 200 with every asset 404.
 */
start("node", [".next/standalone/server.js"], {
  NODE_ENV: "production",
  PORT: String(APP_PORT),
  APP_URL,
  RAILWAY_CLIENT_ID: "e2e-client",
  RAILWAY_CLIENT_SECRET: "e2e-secret",
  SESSION_SECRET: "e2e-session-secret-at-least-32-characters",
  MANAGED_PREFIX: "spun-",
  // Matches playwright.config.ts, so a manually served app watches at the same rate.
  WATCH_POLL_MS: "1000",
  RAILWAY_ISSUER: FIXTURE_URL,
  RAILWAY_API_URL: `${FIXTURE_URL}/graphql/v2`,
  RAILWAY_WS_URL: `ws://localhost:${FIXTURE_PORT}/graphql/v2`,
});

await waitFor(`${FIXTURE_URL}/oauth/.well-known/openid-configuration`, "fake Railway");
await waitFor(`${APP_URL}/api/health`, "the standalone server");

console.log(`ready: app ${APP_URL}, fixture ${FIXTURE_URL}`);
