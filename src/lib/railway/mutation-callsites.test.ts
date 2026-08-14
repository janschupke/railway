import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The ownership rule, stated structurally rather than by convention.
 *
 * None of the mutations below performs an ownership check of its own — each sends its
 * document and nothing else. What makes "this app only changes containers it created" true
 * is that their callers, the lifecycle Server Actions, re-derive ownership from Railway's
 * own response first. That is a property of the call graph, and nothing in the types or the
 * linter defends it: a second caller would bypass the check silently, and every existing
 * test would still pass.
 *
 * So this test asserts the call graph. It is deliberately blunt — a new caller fails here
 * and has to say, in a diff, that it re-derives ownership too.
 *
 * It covered `destroyContainer` alone when destroy was the only thing that could be done to
 * an existing container. Stop, restart and redeploy each change infrastructure the same
 * way, so each is held to the same rule, and the table is what keeps the fifth one from
 * being added without an entry.
 */

const SRC = path.resolve(import.meta.dirname, "..", "..");

/** Where a mutation is allowed to be reached from, relative to `src/`. */
const OWNER = path.join("app", "dashboard", "actions.ts");

/** The module that declares them all, which necessarily names each one. */
const DECLARATION = path.join("lib", "railway", "api.ts");

/**
 * Every call that changes a container that already exists.
 *
 * `deployService` is the one with a second legitimate caller: `createContainer` sends it to
 * start a service it has just registered, which is inside the declaring module and needs no
 * ownership check — nothing prefixed `spun-` exists to own until it returns.
 */
const MUTATIONS = [
  "destroyContainer",
  /*
   * Destroy's second half, and the one that is irreversible in a way the others are not: a
   * deleted service can be recreated, and the data on a deleted volume cannot be recovered
   * at all. Its ownership argument is ADR-13 — a volume's owner is the service it is mounted
   * on — so it sits behind exactly the same guard, and the order assertion below is what
   * keeps it there.
   *
   * The confirmation dialog posts `deleteData`, deliberately not named after this symbol: a
   * form field spelled `deleteVolume` would read as a caller to the blunt search below and
   * make this test pass for the wrong reason.
   */
  "deleteVolume",
  "stopDeployment",
  "restartDeployment",
  /*
   * The edit verb, and the one that changes a container's *description* rather than its
   * running state. It sends up to four mutations of its own — rename, image, variable
   * deletes, variable upsert — and every one of them is inside this single symbol, so the
   * rule holds at the same granularity as the other three.
   */
  "updateContainer",
];

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

/** A file's source with comments stripped — several of them discuss these calls in prose. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function callersOf(symbol: string): string[] {
  return sourceFiles(SRC)
    .filter((file) => code(file).includes(symbol))
    .map((file) => path.relative(SRC, file))
    .sort();
}

describe("container mutations", () => {
  it.each(MUTATIONS)(
    "%s is reachable from the lifecycle actions and nowhere else",
    (symbol) => {
      expect(callersOf(symbol)).toEqual([OWNER, DECLARATION].sort());
    },
  );

  it("deployService is reachable from the lifecycle actions and its own module", () => {
    // The extra caller is `createContainer`, in the declaring module. See MUTATIONS above.
    expect(callersOf("deployService")).toEqual([OWNER, DECLARATION].sort());
  });

  it("re-derives ownership in exactly one place", () => {
    /*
     * One guard, not four. Four copies of "find the service, refuse an unmanaged one" is
     * four chances to write a subtly weaker one, and the weak copy is the one that would
     * ship — so `withManagedContainer` owns the check and the count is what says so.
     */
    const action = code(path.join(SRC, OWNER));
    const guards = action.match(/!target\.managed/g) ?? [];

    expect(guards).toHaveLength(1);
  });

  it.each([...MUTATIONS, "deployService"])(
    "%s is called after the ownership check, never before it",
    (symbol) => {
      /*
       * The order matters as much as the caller: a mutation above the `target.managed`
       * guard would satisfy the tests above while acting first and refusing afterwards.
       */
      const action = code(path.join(SRC, OWNER));
      const guard = action.indexOf("!target.managed");

      expect(guard).toBeGreaterThan(-1);
      expect(action.indexOf(`${symbol}(`)).toBeGreaterThan(guard);
    },
  );
});
