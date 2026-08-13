import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * One Node version, agreed by everything that picks one.
 *
 * A deploy failed on `pnpm i` with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, which reads
 * as a pnpm bug and is not one: Nixpacks had nothing in the repo telling it which Node to
 * build with, defaulted to 18, and corepack then fetched the pinned pnpm 11.9.0, which
 * cannot run there. Every other runtime here was 22 — the CI workflow said so four times,
 * workflow.md said so in prose, and `scripts/` needs it for `--experimental-strip-types`
 * — but the one consumer that decides what actually ships read none of them.
 *
 * `engines.node` is that consumer's input, and it outranks a `.nvmrc` in Nixpacks' own
 * order of precedence, so it is the single place the version belongs. This file is what
 * stops it drifting from the workflow again: the failure it prevents is invisible until
 * a deploy, and by then the diff that caused it is several merges back.
 */
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  engines?: { node?: string };
  packageManager?: string;
};

const ci = readFileSync(".github/workflows/ci.yml", "utf8");

/** The declared major, e.g. "22.x" → 22. */
const declaredMajor = () => {
  const declared = packageJson.engines?.node;
  expect(declared, "package.json must declare engines.node").toBeDefined();
  const major = Number(/\d+/.exec(declared!)?.[0]);
  expect(Number.isInteger(major)).toBe(true);
  return major;
};

describe("the toolchain", () => {
  it("declares the Node version the builder reads", () => {
    /*
     * Pinned to a major rather than left open. `>=22` would let Nixpacks resolve to
     * whatever major it has newest, which is a different runtime arriving without a
     * commit — the opposite of what pinning `packageManager` is for.
     */
    expect(packageJson.engines?.node).toMatch(/^\d+\.x$/);
    expect(declaredMajor()).toBeGreaterThanOrEqual(22);
  });

  it("builds and tests on the major it deploys on", () => {
    // Four jobs set this. All of them, not most: a job left behind is a job proving
    // something about a runtime nobody ships.
    const versions = [...ci.matchAll(/node-version:\s*(\d+)/g)].map((match) =>
      Number(match[1]),
    );

    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) expect(version).toBe(declaredMajor());
  });

  it("keeps the package manager pinned, which is what made the version matter", () => {
    /*
     * corepack fetches exactly this and runs it on whatever Node the image has. A pin
     * here with no floor on Node is the pair that broke — the two are only safe
     * together, so they are asserted together.
     */
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });
});
