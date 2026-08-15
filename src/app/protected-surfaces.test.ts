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
 * So this asserts the call graph. A new route or action either reaches requireSession, or
 * it appears in PUBLIC below with a reason written next to it. Both outcomes are visible
 * in a diff, which is the point.
 *
 * This is a test rather than a lint rule, and the reason is the two hops: reachability
 * across the import graph is the one thing a per-file rule cannot see. The invariants that
 * needed only one file — the client boundary, the cookie jars, the ownership guard — are
 * rules in eslint-rules/ now, and report while you type.
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

/**
 * Whether the file's first *statement* is `"use server"`.
 *
 * The leading-comment strip is the whole point. This used to test the raw text, so a
 * Server Action file that opened with a docblock — which is the house style, and which
 * `actions.ts` itself only escapes by putting the directive above its imports — was not
 * recognised as an action file at all and skipped the guard case below in silence. Line
 * 119 catches exactly one file by name; the next one would not have been caught.
 *
 * Looped rather than a single replace: two comment blocks before the directive is one
 * more than a non-global `^` anchor removes.
 */
function opensWithUseServer(code: string): boolean {
  let head = code.trimStart();
  let previous = "";
  while (head !== previous) {
    previous = head;
    head = head.replace(/^(\/\*[\s\S]*?\*\/|\/\/.*)/, "").trimStart();
  }
  return /^["']use server["']/.test(head);
}

const read = (file: string) => stripComments(readFileSync(file, "utf8"));

/**
 * Local imports, aliased or relative, resolved to files on disk.
 *
 * The `@/…` spelling used to be the only one recognised, which is the same hole
 * local/no-server-imports-in-client was rewritten to close, and it fails in the more
 * dangerous direction here: a route reaching its guard through `./helpers` was reported as
 * unprotected, so the fix for a red build was to add it to PUBLIC. A guard walk that
 * cannot see half the import graph teaches people to widen the exemption list.
 */
function importedFiles(code: string, file: string): string[] {
  const specifiers = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
  return specifiers.flatMap((specifier) => {
    const base = specifier.startsWith("@/")
      ? path.join(SRC, specifier.slice("@/".length))
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(file), specifier)
        : // A package. Nothing outside src/ declares a guard.
          null;
    if (base === null) return [];
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

/**
 * Whether this file calls a guard, or imports one for something it hands on.
 *
 * `code.includes(guard)` was the whole check, and a substring match is satisfied by more
 * than it looks: a variable called `requireSessionLater`, a string carrying the name, a
 * type-only import. Comments were already stripped, so those are what was left. Both
 * forms are needed rather than the call alone — an intermediate module in the two-hop
 * walk may import the guard and pass it on rather than call it.
 */
function namesGuard(code: string, guard: string): boolean {
  const called = new RegExp(`\\b${guard}\\s*\\(`).test(code);
  const imported = new RegExp(`import[^;]*\\b${guard}\\b[^;]*from\\s*["']`, "s").test(
    code,
  );
  return called || imported;
}

/** Whether a guard is named in this file or in anything it imports, up to `depth` hops. */
function reachesGuard(file: string, depth: number, seen = new Set<string>()): boolean {
  if (seen.has(file) || depth < 0) return false;
  seen.add(file);

  const code = read(file);
  if (GUARDS.some((guard) => namesGuard(code, guard))) return true;

  return importedFiles(code, file).some((next) => reachesGuard(next, depth - 1, seen));
}

describe("protected surfaces", () => {
  const routes = sourceFiles(APP)
    .filter((file) => path.basename(file) === "route.ts")
    .map((file) => path.relative(APP, file));

  const actionFiles = sourceFiles(SRC)
    .filter((file) => opensWithUseServer(readFileSync(file, "utf8")))
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
