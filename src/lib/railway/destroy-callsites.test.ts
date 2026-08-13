import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The ownership rule, stated structurally rather than by convention.
 *
 * `destroyContainer` performs no ownership check of its own — it sends `serviceDelete`
 * and nothing else. What makes "this app only destroys services it created" true is
 * that its single caller, the `spinDown` Server Action, re-derives ownership from
 * Railway's own response first. That is a property of the call graph, and nothing in
 * the types or the linter defends it: a second caller would bypass the check silently,
 * and every existing test would still pass.
 *
 * So this test asserts the call graph. It is deliberately blunt — a new caller fails
 * here and has to say, in a diff, that it re-derives ownership too.
 */

const SRC = path.resolve(import.meta.dirname, "..", "..");

/** Where the destroy is allowed to be reached from, relative to `src/`. */
const OWNER = path.join("app", "dashboard", "actions.ts");

/** The module that declares it, which necessarily names it. */
const DECLARATION = path.join("lib", "railway", "api.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    // Tests reach for it on purpose; `src/test/` is harness, not shipped code.
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    if (path.relative(SRC, full).startsWith("test" + path.sep)) return [];
    return [full];
  });
}

describe("destroyContainer", () => {
  it("is reachable from the spin-down action and nowhere else", () => {
    const callers = sourceFiles(SRC)
      .filter((file) => {
        // Comments stripped: api.ts and actions.ts both discuss the destroy in prose,
        // and so does anything explaining why it is not called.
        const code = readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        return code.includes("destroyContainer");
      })
      .map((file) => path.relative(SRC, file))
      .sort();

    expect(callers).toEqual([OWNER, DECLARATION].sort());
  });

  it("is preceded by the ownership check in the one place it is called", () => {
    /*
     * The order matters as much as the caller: a `destroyContainer` above the
     * `target.managed` guard would satisfy the test above while deleting first and
     * refusing afterwards.
     */
    const action = readFileSync(path.join(SRC, OWNER), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(action.indexOf("!target.managed")).toBeGreaterThan(-1);
    expect(action.indexOf("destroyContainer(")).toBeGreaterThan(
      action.indexOf("!target.managed"),
    );
  });
});
