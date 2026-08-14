import { describe, expect, it } from "vitest";
import { fingerprint } from "./watch-fingerprint";
import type { Container } from "./types";

const container = (over: Partial<Container> = {}): Container => ({
  serviceId: "svc_1",
  rawName: "spun-cache",
  displayName: "cache",
  image: "redis:7-alpine",
  repo: null,
  state: "running",
  rawStatus: "SUCCESS",
  deploymentId: "dep_1",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  deployedAt: "2026-08-01T00:00:00Z",
  managed: true,
  ...over,
});

const base = [container(), container({ serviceId: "svc_2", rawName: "postgres" })];

describe("the watch fingerprint", () => {
  it("is stable when nothing visible changed", () => {
    expect(fingerprint(base)).toBe(fingerprint([...base]));
  });

  it("ignores the order Railway happens to return", () => {
    // Reordered edges are not a change, and treating them as one would refresh the page
    // on a coin flip.
    expect(fingerprint([...base].reverse())).toBe(fingerprint(base));
  });

  it("ignores updatedAt", () => {
    /*
     * The deliberate gap. Railway bumps updatedAt on every deployment tick, so including
     * it would refresh the whole page every interval for the length of a build — a
     * window the row's own deployment stream already owns. The cost is that redeploying
     * the same image to the same state goes unnoticed here; see ADR-10.
     */
    const bumped = base.map((c) => ({ ...c, updatedAt: "2026-09-09T00:00:00Z" }));
    expect(fingerprint(bumped)).toBe(fingerprint(base));
  });

  it("ignores deployedAt", () => {
    // Redundant rather than deliberately dropped: deployedAt moves at exactly the moment
    // deploymentId does, and that IS hashed — so the change is already noticed, and this
    // field would only add one more fluctuating input to reason about.
    const redeployed = base.map((c) => ({ ...c, deployedAt: "2026-09-09T00:00:00Z" }));
    expect(fingerprint(redeployed)).toBe(fingerprint(base));
  });

  it.each([
    ["a state change", { state: "failed" as const }],
    ["a new deployment", { deploymentId: "dep_99" }],
    ["a different image", { image: "redis:8" }],
    ["a rename", { rawName: "spun-renamed" }],
    ["a switch to a repo source", { image: null, repo: "owner/app" }],
  ])("notices %s", (_label, over) => {
    const changed = [container(over), base[1]!];
    expect(fingerprint(changed)).not.toBe(fingerprint(base));
  });

  it("notices a service appearing or disappearing", () => {
    expect(fingerprint(base.slice(0, 1))).not.toBe(fingerprint(base));
    expect(fingerprint([...base, container({ serviceId: "svc_3" })])).not.toBe(
      fingerprint(base),
    );
  });

  it("stays a fixed size whatever the project holds", () => {
    // Hashed rather than kept verbatim: a watcher's memory must not scale with a project.
    const many = Array.from({ length: 500 }, (_, i) =>
      container({ serviceId: `svc_${i}` }),
    );
    expect(fingerprint(many).length).toBe(fingerprint(base).length);
  });
});
