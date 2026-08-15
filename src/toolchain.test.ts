import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
 * `node-version` keys and the major everything else deploys on, and the Dockerfile's two
 * `FROM` lines against each other. Nothing at runtime would notice a disagreement, and a
 * deploy would notice it late.
 *
 * Two assertions are a different shape and belong here for the same reason: a claim about
 * the build restated in a second file, where nothing at runtime would ever compare them.
 *
 * ci.yml's job list against the aggregator's `needs` — a job that gates nothing is a check
 * that is not a check, and this repository ran without one building the deployment image
 * for long enough to prove nothing else was going to say so.
 *
 * And `package.json`'s `check` script against the four files that describe it. Three of
 * them dropped `codegen:check`, which is the step that catches an edited `operations.ts`
 * whose types were never regenerated — so anyone following AGENTS.md, the Cursor rules or
 * the pull-request template ran five sixths of the gate and reported it green.
 */
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  engines?: { node?: string };
  packageManager?: string;
  scripts?: Record<string, string>;
};

/**
 * Every file that tells a reader what `pnpm check` runs.
 *
 * workflow.md is the rule; the other three are the ones somebody actually has open —
 * AGENTS.md and main.mdc when it is an agent, the template when it is a person ticking
 * boxes. All three had drifted from the script.
 */
const gateDocs = {
  "AGENTS.md": readFileSync("AGENTS.md", "utf8"),
  ".cursor/rules/main.mdc": readFileSync(".cursor/rules/main.mdc", "utf8"),
  ".ai/rules/workflow.md": readFileSync(".ai/rules/workflow.md", "utf8"),
  ".github/pull_request_template.md": readFileSync(
    ".github/pull_request_template.md",
    "utf8",
  ),
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

/**
 * The base image a stage names, as `[reference, major]` — e.g.
 * `["node:22.23.2-alpine@sha256:c610…", "22"]`. Null if the stage does not exist or does
 * not pin both a full version and a digest.
 */
const baseImage = (stage: string) =>
  new RegExp(
    String.raw`^FROM (node:(\d+)\.\d+\.\d+-\w+@sha256:[0-9a-f]{64}) AS ${stage}$`,
    "m",
  ).exec(dockerfile);

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

  it("builds the image on the Node the package declares, by digest", () => {
    /*
     * The digest is required, not optional. A tag is a pointer its owner can move, and the
     * base image was the last mutable reference left in the deployment path once the
     * actions in ci.yml were pinned — so a tag-only FROM is a version that can change
     * without a commit, which is the thing the whole file is against.
     */
    const base = baseImage("base");
    expect(
      base,
      "Dockerfile must pin a full node version and a sha256 digest in its base stage",
    ).not.toBeNull();
    expect(Number(base![2])).toBe(declaredMajor());
  });

  it("runs on the same base image it builds on", () => {
    /*
     * The runtime stage starts from the registry rather than from `base`, so that pnpm is
     * absent from it. That is deliberate and it means the two references are written out
     * twice — two literals, which is exactly the kind of pair this file exists to hold
     * together. A runtime on a different Node than the build is a difference nothing at
     * build time would report and every deploy would carry.
     */
    const runner = baseImage("runner");
    expect(
      runner,
      "Dockerfile must pin a full node version and a sha256 digest in its runtime stage",
    ).not.toBeNull();
    expect(runner![1]).toBe(baseImage("base")![1]);
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

  it("gates every job it defines", () => {
    /*
     * `required` is the one check name branch protection requires, and it is only as wide
     * as its `needs` list. A job added to this workflow and left out of that list runs,
     * reports, and gates nothing — the merge goes green on the strength of the jobs that
     * were remembered. Nothing else notices: the run is not red, the job is not skipped,
     * and the aggregator's own two assertions only speak about the jobs it was given.
     *
     * This repository shipped for months with no job building the deployment image at all,
     * which is the same failure one layer out. So the list is derived rather than trusted.
     */
    /*
     * Parsed, not matched. This read the job names with `^ {2}(\w[\w-]*):$` and the
     * aggregator's list with `^ {4}needs: \[([^\]]+)\]$`, which hardcodes both the
     * indent width and the flow-sequence spelling — so rewriting `needs: [a, b]` as a
     * block list, which is the same document to GitHub Actions, made this red for no
     * behavioural reason. The two-space indent was load-bearing in the other direction
     * too: any nested key two levels down would have been read as a job.
     */
    const workflow = parse(ci) as {
      jobs?: Record<string, { needs?: string | string[] }>;
    };

    const jobs = Object.keys(workflow.jobs ?? {});
    expect(jobs, "ci.yml must define jobs").not.toHaveLength(0);
    expect(jobs).toContain("required");

    const needs = workflow.jobs?.required?.needs;
    expect(needs, "`required` must have a needs list").toBeDefined();

    const gated = typeof needs === "string" ? [needs] : (needs ?? []);
    expect(gated.toSorted()).toEqual(
      jobs.filter((job) => job !== "required").toSorted(),
    );
  });

  it("is described by every file that lists what `pnpm check` runs", () => {
    /*
     * Four files state the composition of the gate and three of them were wrong the same
     * way: AGENTS.md, .cursor/rules/main.mdc and the pull-request template all omitted
     * `codegen:check`. Only workflow.md had it.
     *
     * That is the worst of the four to lose. `codegen:check` regenerates the documents'
     * types and fails if the result differs from what is committed, so it is the step that
     * catches an edited `operations.ts` whose types were never regenerated — and the three
     * files that dropped it are the ones an agent reads first and a contributor ticks off
     * by hand. Someone following any of them ran five sixths of the gate and reported it
     * green.
     *
     * Derived from package.json rather than restated here, so this assertion cannot become
     * the fifth copy of the same list.
     */
    const script = packageJson.scripts?.check;
    expect(script, "package.json must define a `check` script").toBeDefined();

    const steps = script!
      .split("&&")
      .map((part) => part.trim().replace(/^pnpm\s+/, ""));

    expect(steps.length).toBeGreaterThan(0);

    for (const [file, text] of Object.entries(gateDocs)) {
      for (const step of steps) {
        expect(
          text,
          `${file} omits \`${step}\` from what \`pnpm check\` runs`,
        ).toContain(step);
      }
    }
  });

  /*
   * `.cursor/rules/main.mdc` is generated from AGENTS.md now — `pnpm cursor:generate`,
   * asserted current by `pnpm cursor:check` inside `pnpm check`.
   *
   * What was here compared the two files' `- **` bullets for byte equality, and it had
   * caught real drift: eleven ADRs against fourteen, `codegen:check` missing from the
   * gate, the ADR-14 volume clause dropped from the ownership bullet. But byte equality
   * only ever guarded the bullets, so the prose around them drifted twice more
   * afterwards — and worse, it *required* a broken link. AGENTS.md writes
   * `[workflow.md](.ai/rules/workflow.md)`, which resolves from the repo root; copied
   * verbatim into `.cursor/rules/` it points at `.cursor/rules/.ai/rules/workflow.md`.
   * Every other link in that file was hand-written `../../` precisely because those
   * bullets were not under test.
   *
   * Generating removes the class rather than testing one instance of it: the whole file
   * is derived, and the links are rewritten for the depth it actually sits at.
   */

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
    /*
     * Scoped to the credentials rather than to the `RAILWAY` prefix. The runtime stage
     * takes `ARG RAILWAY_GIT_COMMIT_SHA` for the OCI revision label, which is a commit id
     * — public, already on every log line, and the opposite of a thing that must not be
     * overridable from outside.
     */
    expect(dockerfile).not.toMatch(/^ARG (RAILWAY_CLIENT|SESSION)/m);
    expect(dockerfile).not.toMatch(/^ENV (RAILWAY_CLIENT|SESSION_SECRET)/m);
  });
});
