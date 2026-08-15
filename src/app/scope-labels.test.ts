import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every request scope is labelled with the thing it is actually scoping.
 *
 * `withRequestScope(label, { trustInboundId }, run)` is called from twenty places and each
 * one writes its own name twice — once as the exported function or the route's own path,
 * once as a string argument. Nothing checked that the two agreed, and a label is not
 * inert: it becomes `route` on every log line the request emits, so a stale one after a
 * rename sends an operator reading `stopContainer` to a function that has not existed for
 * months. The tidier-looking fix — a `scopedAction(name, fn)` helper generating the export
 * — is not available: `actions.ts` is a `"use server"` file and Next refuses any export
 * that is not a function declaration, so `export const x = scopedAction(…)` does not
 * compile. Checking the agreement costs nothing and catches the same drift.
 *
 * The third assertion is the one that matters most, and it is not about tidiness at all.
 * `trustInboundId` decides whether a client-supplied `x-request-id` is adopted, and the
 * rule is stated in security.md and errors-and-logging.md: adopt only behind the proxy
 * matcher, which overwrites the header unconditionally, and mint for the routes the
 * matcher excludes. Today four correct comments are the only thing holding that; a fifth
 * route copying the wrong neighbour would let a caller choose the id its own log lines are
 * grouped under, and forge someone else's.
 */

const SRC = path.resolve(import.meta.dirname, "..");
const API = path.join(SRC, "app", "api");

/** `withRequestScope("label", { trustInboundId: bool }` — the two arguments that drift. */
const CALL =
  /withRequestScope\(\s*"([^"]+)"\s*,\s*\{\s*trustInboundId:\s*(true|false)/g;

const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

/**
 * The route's own path, as Next names it — `api/watch/[projectId]` becomes
 * `/api/watch/[projectId]`, dynamic segment and all.
 */
const patternOf = (file: string) =>
  `/${path.relative(path.join(SRC, "app"), path.dirname(file)).split(path.sep).join("/")}`;

/**
 * The paths `proxy.ts` excludes from its matcher, which is where the header is stamped.
 *
 * Read off the matcher rather than restated, so widening or narrowing it moves this test
 * with it instead of leaving a stale copy behind.
 */
const excluded = (() => {
  const matcher = readFileSync(path.join(SRC, "proxy.ts"), "utf8");
  const negated = /\(\?!([^)]+)\)/.exec(matcher)?.[1];
  expect(negated, "could not read the proxy matcher's exclusion list").toBeTruthy();
  return (negated ?? "").split("|").map((entry) => `/${entry}`);
})();

const isExcluded = (pattern: string) =>
  excluded.some((prefix) => pattern === prefix || pattern.startsWith(`${prefix}/`));

describe("the request scope's label", () => {
  const actions = path.join(SRC, "app", "dashboard", "actions.ts");

  it("names the Server Action it wraps", () => {
    const source = code(actions);
    /*
     * Each forwarder is `export async function X(…) { return withRequestScope("X", …`, so
     * the enclosing name is the nearest `export async function` above the call.
     */
    const exports = [...source.matchAll(/export async function (\w+)/g)];
    const calls = [...source.matchAll(CALL)];
    expect(calls.length).toBeGreaterThan(8);

    for (const call of calls) {
      const enclosing = exports.filter((each) => each.index < call.index).at(-1);
      expect(enclosing?.[1], `no exported function above ${call[1]}`).toBeTruthy();
      expect(call[1], `the scope label under ${enclosing?.[1]}`).toBe(enclosing?.[1]);
    }
  });

  it("names the route it wraps", () => {
    const routes = routeFiles(API);
    // A discovery bug would empty this and pass in silence.
    expect(routes.length).toBeGreaterThan(5);

    for (const file of routes) {
      for (const call of code(file).matchAll(CALL)) {
        expect(call[1], `the scope label in ${patternOf(file)}/route.ts`).toBe(
          patternOf(file),
        );
      }
    }
  });

  it("names the page the dashboard loaders serve", () => {
    // Not a function name: these are Server Component loaders, and the thing a log reader
    // wants beside them is the page whose render they belong to.
    for (const call of code(path.join(SRC, "app", "dashboard", "data.ts")).matchAll(
      CALL,
    )) {
      expect(call[1]).toBe("/dashboard");
    }
  });
});

describe("adopting an inbound request id", () => {
  it("is trusted behind the proxy matcher and minted outside it", () => {
    const routes = routeFiles(API);
    const seen: string[] = [];

    for (const file of routes) {
      const pattern = patternOf(file);
      for (const call of code(file).matchAll(CALL)) {
        seen.push(pattern);
        /*
         * Behind the matcher, proxy.ts overwrites `x-request-id` on every request, so what
         * arrives at the handler is this app's own. Outside it — api/auth/* — nothing has,
         * and the value is whatever the caller sent.
         */
        expect(call[2] === "true", `trustInboundId in ${pattern}/route.ts`).toBe(
          !isExcluded(pattern),
        );
      }
    }

    // Both sides of the rule are exercised, so neither branch is vacuous.
    expect(seen.filter(isExcluded).length).toBeGreaterThan(0);
    expect(seen.filter((pattern) => !isExcluded(pattern)).length).toBeGreaterThan(0);
  });
});
