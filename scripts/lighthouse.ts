/**
 * `pnpm lighthouse`, as one command.
 *
 * It used to be `pnpm lh:auth && lhci autorun`, and both halves need a server that neither
 * of them starts — so the documented way to run it was two shells, and the gate went unrun
 * for two rounds because nobody had two shells to hand.
 *
 * lhci can start a server itself, through `startServerCommand`, and that is not enough here:
 * `lighthouserc.cjs` reads the session cookie **while it is being loaded**, which is before
 * any server of lhci's exists, and `lh:auth` cannot mint that cookie without one. So the
 * order has to be server, then auth, then lhci — and something has to own the server across
 * all three. This is that something.
 *
 * `serve-e2e.ts` is the server, unchanged and shared with Playwright's `webServer`, which is
 * what keeps Lighthouse and the e2e suite measuring the same build rather than two that have
 * drifted.
 *
 * Both steps are run through their own package scripts rather than by naming the binaries
 * here. That is what keeps `@lhci/cli` a dependency knip can see used: it reads package.json
 * scripts, and a tool spawned by name from inside a TypeScript file is invisible to it.
 */

import { spawn, type ChildProcess } from "node:child_process";

const APP_URL = `http://localhost:${process.env.APP_PORT ?? 3100}`;
const READY_TIMEOUT_MS = 180_000;

let server: ChildProcess | null = null;

function stopServer(): void {
  if (!server || server.exitCode !== null) return;
  // The whole process group: serve-e2e spawns next and the fake Railway under itself.
  server.kill("SIGTERM");
  server = null;
}

process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopServer();
  process.exit(143);
});

/** Runs a command to completion, inheriting stdio, and resolves with its exit code. */
function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function waitForApp(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`serve:e2e exited with ${server.exitCode} before answering`);
    }
    try {
      const response = await fetch(`${APP_URL}/api/health`);
      // 503 is a *ready* server reporting a misconfiguration, which is still an answer:
      // serve-e2e supplies the environment, so this only has to mean "listening".
      if (response.status < 500 || response.status === 503) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((settle) => setTimeout(settle, 250));
  }
  throw new Error(`${APP_URL} did not answer within ${READY_TIMEOUT_MS}ms`);
}

let code = 1;
try {
  /*
   * Node directly rather than `pnpm serve:e2e`, with the same flags the script uses. Not a
   * style choice: serve-e2e.ts kills its own children on SIGTERM, and a package-manager
   * wrapper in between is one more process for that signal to be swallowed by — the fake
   * Railway and the app server would outlive this run and hold their ports. The flags are
   * `--experimental-strip-types` because the file is TypeScript and has top-level await,
   * which is exactly what tsx's CJS transform refuses.
   */
  server = spawn(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", "scripts/serve-e2e.ts"],
    { stdio: "inherit" },
  );
  await waitForApp();

  // The cookie first: lighthouserc.cjs reads it as it loads, and throws if it is missing.
  code = await run("pnpm", ["lh:auth"]);
  if (code === 0) code = await run("pnpm", ["lh:collect"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  code = 1;
} finally {
  stopServer();
}

process.exit(code);
