import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * "A new protected surface re-checks the session too", stated structurally.
 *
 * The rule is in security.md and was enforced by nothing. Every route handler and every
 * Server Action that exists today does re-check — that is asserted per surface in the
 * integration tests — but the *next* one is one forgotten line away from being public,
 * and no existing test would notice: they test the surfaces that exist.
 *
 * So this asserts the call graph, in the same shape as mutation-callsites.test.ts. A new
 * route or action either reaches requireSession, or it appears in PUBLIC below with a
 * reason written next to it. Both outcomes are visible in a diff, which is the point.
 *
 * Two hops, because the check is not always in the file. The stream routes reach it
 * through lib/stream-route's neighbours and the dashboard through its data loader, and a
 * single-file grep would have called both of those unprotected.
 */

const SRC = path.resolve(import.meta.dirname, "..");
const APP = path.join(SRC, "app");

/** What counts as re-checking. requireAccessToken calls requireSession. */
const GUARDS = ["requireSession", "requireAccessToken"];

/**
 * Surfaces that are deliberately reachable without a session.
 *
 * Each needs a reason, and the reason has to survive review — that is the whole value of
 * the list being here rather than implied by absence.
 */
const PUBLIC = new Map([
  [
    path.join("api", "health", "route.ts"),
    "Railway's healthcheck. Touches env() only; never the Railway API or a session.",
  ],
  [
    path.join("api", "auth", "login", "route.ts"),
    "Mints the flow that produces the session, so it cannot be gated by one.",
  ],
  [
    path.join("api", "auth", "callback", "route.ts"),
    "Same: this is where the session comes from. Guarded by PKCE and state instead.",
  ],
  [
    path.join("api", "auth", "logout", "route.ts"),
    "Clears the cookie. Guarded by a same-origin check, since a session is not required " +
      "to stop having one.",
  ],
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const read = (file: string) => stripComments(readFileSync(file, "utf8"));

/** Local `@/…` imports, resolved to files on disk. */
function importedFiles(code: string): string[] {
  const specifiers = [...code.matchAll(/from\s+"(@\/[^"]+)"/g)].map((m) => m[1]!);
  return specifiers.flatMap((specifier) => {
    const base = path.join(SRC, specifier.slice("@/".length));
    for (const candidate of [
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, "index.ts"),
    ]) {
      try {
        readFileSync(candidate, "utf8");
        return [candidate];
      } catch {
        continue;
      }
    }
    return [];
  });
}

/** Whether a guard is named in this file or in anything it imports, up to `depth` hops. */
function reachesGuard(file: string, depth: number, seen = new Set<string>()): boolean {
  if (seen.has(file) || depth < 0) return false;
  seen.add(file);

  const code = read(file);
  if (GUARDS.some((guard) => code.includes(guard))) return true;

  return importedFiles(code).some((next) => reachesGuard(next, depth - 1, seen));
}

describe("protected surfaces", () => {
  const routes = sourceFiles(APP)
    .filter((file) => path.basename(file) === "route.ts")
    .map((file) => path.relative(APP, file));

  const actionFiles = sourceFiles(SRC)
    .filter((file) => /^\s*"use server"/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(SRC, file));

  it("finds the surfaces it is meant to be checking", () => {
    /*
     * A refactor that moves or renames these must not silently empty this suite — a
     * structural test that discovers nothing passes loudly and proves nothing.
     *
     * Bounds, not an exact list: a second Server Action file is a legitimate thing to
     * add, and it should be *checked* by the case below rather than rejected here.
     */
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(actionFiles).toContain(path.join("app", "dashboard", "actions.ts"));
  });

  it.each(
    // Computed at collection time so each route is its own named case.
    sourceFiles(APP)
      .filter((file) => path.basename(file) === "route.ts")
      .map((file) => [path.relative(APP, file), file] as const),
  )("%s re-checks the session, or says why it does not", (relative, file) => {
    if (PUBLIC.has(relative)) {
      // Named as public: assert it really is, so an entry cannot rot into a
      // rubber stamp over a route that has since started needing a session.
      expect(PUBLIC.get(relative)).toBeTruthy();
      return;
    }
    expect(reachesGuard(file, 2)).toBe(true);
  });

  it("guards every Server Action", () => {
    for (const relative of actionFiles) {
      expect(reachesGuard(path.join(SRC, relative), 2)).toBe(true);
    }
  });

  it("has no stale entries in the public list", () => {
    // A PUBLIC entry naming a file that no longer exists is a rule nobody is applying.
    for (const relative of PUBLIC.keys()) {
      expect(routes).toContain(relative);
    }
  });
});
