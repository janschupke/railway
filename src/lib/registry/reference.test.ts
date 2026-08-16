import { describe, expect, it } from "vitest";
import { PRESETS, repositoryOf } from "../presets";
import { IMAGE_PATTERN, parseImageReference } from "./reference";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("parseImageReference", () => {
  it.each([
    ["a bare official name", "redis", "docker.io", "library/redis", "latest"],
    [
      "a tagged official name",
      "redis:7-alpine",
      "docker.io",
      "library/redis",
      "7-alpine",
    ],
    ["a namespaced name", "traefik/whoami", "docker.io", "traefik/whoami", "latest"],
    ["ghcr", "ghcr.io/owner/app:1.2.3", "ghcr.io", "owner/app", "1.2.3"],
    [
      "quay",
      "quay.io/prometheus/prometheus:latest",
      "quay.io",
      "prometheus/prometheus",
      "latest",
    ],
    ["a deep path", "ghcr.io/owner/team/app", "ghcr.io", "owner/team/app", "latest"],
  ])("splits %s", (_label, image, registry, repository, reference) => {
    expect(parseImageReference(image)).toEqual({ registry, repository, reference });
  });

  it.each([
    "docker.io/library/redis",
    "index.docker.io/library/redis",
    "registry-1.docker.io/library/redis",
  ])("normalizes %s onto docker.io", (image) => {
    expect(parseImageReference(image)?.registry).toBe("docker.io");
  });

  it("prefixes library/ only for a single-component Docker Hub name", () => {
    expect(parseImageReference("redis")?.repository).toBe("library/redis");
    expect(parseImageReference("traefik/whoami")?.repository).toBe("traefik/whoami");
    // Not a Docker Hub name, so the rule does not apply however few components it has.
    expect(parseImageReference("ghcr.io/app")?.repository).toBe("app");
  });

  it("takes the digest as the reference, and lets it beat a tag", () => {
    expect(parseImageReference(`alpine@${DIGEST}`)).toEqual({
      registry: "docker.io",
      repository: "library/alpine",
      reference: DIGEST,
    });
    expect(parseImageReference(`alpine:3.20@${DIGEST}`)?.reference).toBe(DIGEST);
  });

  it("uppercases the host but not the path, because only one of them may be", () => {
    expect(parseImageReference("GHCR.IO/owner/app")?.registry).toBe("ghcr.io");
    // A repository path is lowercase in the OCI grammar, so this is unreadable rather
    // than case-folded — the app says nothing about it instead of guessing.
    expect(parseImageReference("ghcr.io/Owner/App")).toBeNull();
  });

  /*
   * The SSRF claim in docs/limitations.md, made executable.
   *
   * A first component containing a dot is a registry under Docker's own rules, so a
   * metadata address is a well-formed reference and this parser says so plainly. What
   * refuses to dereference it is `registryFor` in ./registries, which has no entry for it.
   * The two halves are deliberately separate: if this function ever started returning null
   * here, the allowlist would still be the control, and a reader would be left thinking the
   * parser was one.
   */
  it.each([
    ["cloud metadata", "169.254.169.254/foo/bar", "169.254.169.254"],
    ["an unlisted registry", "registry.example.com/x", "registry.example.com"],
  ])("reads %s as a registry host rather than a repository", (_l, image, registry) => {
    expect(parseImageReference(image)?.registry).toBe(registry);
  });

  /*
   * A host with a port never gets this far, and it is worth knowing why rather than
   * assuming the parser handles it: IMAGE_PATTERN's tag group cannot contain a slash, so
   * `localhost:5000/app` fails the pattern outright and the spin-up form has always
   * refused it. The port-aware tag rule above is therefore belt to that braces — it keeps
   * this function correct read on its own, which is how it will be read.
   */
  it("never sees a registry port, because the pattern refuses one first", () => {
    expect(IMAGE_PATTERN.test("localhost:5000/app")).toBe(false);
    expect(parseImageReference("localhost:5000/app")).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["a traversal", "../etc/passwd"],
    ["a traversal mid-path", "owner/../../x"],
    ["an encoded traversal", "owner/%2e%2e/x"],
    ["an empty component", "owner//app"],
    ["a bare host with no path", "ghcr.io"],
    ["a shell metacharacter", "redis; rm -rf /"],
    ["a malformed digest", "alpine@sha256:beef"],
    ["two digests", `alpine@${DIGEST}@${DIGEST}`],
  ])("returns null for %s", (_label, image) => {
    expect(parseImageReference(image)).toBeNull();
  });

  /*
   * The tag rule is written twice in this repo — here and in `repositoryOf`, which the
   * preset catalog matches on — and the two disagreeing would be invisible: the form would
   * seed one image's variables and check another's existence. This is the assertion that
   * they do not.
   */
  it.each(PRESETS.map((preset) => preset.value))(
    "agrees with repositoryOf on %s",
    (value) => {
      const parsed = parseImageReference(value);
      expect(parsed).not.toBeNull();
      const repository = parsed!.repository.replace(/^library\//, "");
      expect(repository).toBe(repositoryOf(value));
    },
  );

  it("parses every preset onto Docker Hub", () => {
    for (const preset of PRESETS) {
      expect(parseImageReference(preset.value)?.registry).toBe("docker.io");
    }
  });
});

describe("IMAGE_PATTERN", () => {
  /*
   * The pattern moved out of the zod schemas so the browser could hold it without zod.
   * These cases are the ones validation/schemas.test.ts asserts through `spinUpSchema`, repeated
   * here against the regex itself so a change to it fails at the source rather than three
   * modules away.
   */
  it.each(["redis", "redis:7-alpine", "ghcr.io/owner/app:1.2.3", `alpine@${DIGEST}`])(
    "accepts %s",
    (image) => expect(IMAGE_PATTERN.test(image)).toBe(true),
  );

  it.each(["redis; rm -rf /", "redis 7", "/redis", "redis`whoami`"])(
    "rejects %s",
    (image) => expect(IMAGE_PATTERN.test(image)).toBe(false),
  );

  /*
   * Linear, with no nested quantifier and disjoint atom classes — the claim SECURITY.md
   * makes about this regex, and one nothing asserted while it lived beside them.
   * Generous ceiling: this is a catastrophic-backtracking check, not a benchmark.
   */
  it("does not backtrack catastrophically on adversarial input", () => {
    const started = performance.now();
    expect(IMAGE_PATTERN.test(`${"a.".repeat(50_000)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
