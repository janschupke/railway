import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * One Node, one pnpm, agreed by every file that names one.
 *
 * A deploy failed on `pnpm i` with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, which reads as
 * a pnpm bug and is not one. Nixpacks resolved `pnpm` to the corepack shim in its Node
 * derivation; corepack read `packageManager`, downloaded pnpm 11.9.0, and compiled its
 * entry point — a three-line CJS shim whose only statement is `import('./pnpm.mjs')` —
 * without a dynamic-import callback. Reproduced by version: corepack 0.20.0 and 0.24.1
 * fail exactly that way and cache to `corepack/pnpm/11.9.0`, the path the deploy printed;
 * 0.31.0 and later succeed and cache to `corepack/v1/pnpm/11.9.0`, which it did not. The
 * cause was the builder's corepack, which is not a thing this repository can pin.
 *
 * So the versions are stated in the Dockerfile instead, and this file is what stops the
 * three files that name them drifting apart. Each pair is two literals with nothing
 * between them: package.json's `engines.node` and the `FROM` line, package.json's
 * `packageManager` and the `npm install --global pnpm@` line, ci.yml's four
 * `node-version` keys and the major everything else deploys on. Nothing at runtime would
 * notice a disagreement, and a deploy would notice it late.
 */
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  engines?: { node?: string };
  packageManager?: string;
};

const dockerfile = readFileSync("Dockerfile", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const railwayJson = JSON.parse(readFileSync("railway.json", "utf8")) as {
  build?: { builder?: string };
  deploy?: { startCommand?: string };
};

/** The declared major, e.g. "22.x" → 22. */
const declaredMajor = () => {
  const declared = packageJson.engines?.node;
  expect(declared, "package.json must declare engines.node").toBeDefined();
  return Number(/\d+/.exec(declared!)?.[0]);
};

describe("the toolchain", () => {
  it("pins Node to a major rather than a floor", () => {
    /*
     * `>=22` would let a builder resolve to whatever major it has newest — a different
     * runtime arriving without a commit, which is the opposite of what pinning
     * `packageManager` is for.
     */
    expect(packageJson.engines?.node).toMatch(/^\d+\.x$/);
    expect(declaredMajor()).toBeGreaterThanOrEqual(22);
  });

  it("builds the image on the Node the package declares", () => {
    const from = /^FROM node:(\d+)\.\d+\.\d+-\w+ AS base$/m.exec(dockerfile);
    expect(
      from,
      "Dockerfile must pin a full node version in its base stage",
    ).not.toBeNull();
    expect(Number(from![1])).toBe(declaredMajor());
  });

  it("installs the pnpm the package pins, from npm rather than corepack", () => {
    /*
     * The two have to be the same version, and the install has to be `npm install
     * --global pnpm@<version>`. Anything that reads `packageManager` at build time is
     * corepack by another name, and corepack's version belongs to the base image.
     */
    const pinned = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager ?? "");
    expect(
      pinned,
      "package.json must pin packageManager to an exact pnpm",
    ).not.toBeNull();

    const installed = /npm install --global[^\n]*\spnpm@(\d+\.\d+\.\d+)/.exec(
      dockerfile,
    );
    expect(installed, "Dockerfile must install pnpm from npm").not.toBeNull();
    expect(installed![1]).toBe(pinned![1]);

    expect(dockerfile).not.toMatch(/corepack (enable|prepare)/);
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

  it("lets the Dockerfile decide how the app starts", () => {
    /*
     * The runtime stage deliberately has no package manager in it, so a `startCommand`
     * of `pnpm start` — which is what this file carried under NIXPACKS — would be a
     * deploy that builds cleanly and then cannot boot.
     */
    expect(railwayJson.build?.builder).toBe("DOCKERFILE");
    expect(railwayJson.deploy?.startCommand).toBeUndefined();
  });

  it("keeps the build free of real credentials", () => {
    /*
     * ci.yml states this at workflow level — the build must not need real credentials,
     * and an env schema that starts demanding them is a legitimate failure. The
     * Dockerfile enforces it by setting the four inline on the build command, where
     * nothing outside can override them and no layer records them.
     */
    expect(dockerfile).toMatch(/RAILWAY_CLIENT_SECRET=build-placeholder/);
    expect(dockerfile).not.toMatch(/^ARG (RAILWAY|SESSION)/m);
    expect(dockerfile).not.toMatch(/^ENV (RAILWAY_CLIENT|SESSION_SECRET)/m);
  });
});
