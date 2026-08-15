/**
 * Docker image reference: `[registry/]name[:tag][@digest]`.
 * Deliberately permissive on registry hosts, strict on shell-unsafe characters.
 *
 * Lives here rather than in ./validation.ts, where it was born, because both sides of the
 * app need it and only one of them can afford zod. `spinUpSchema` imports it from here; so
 * does the image-check hook, which runs in the browser — and a hook that reached into
 * `lib/validation` would pull zod into /dashboard's first load for the sake of one regex.
 * This module imports nothing at all, which is what keeps that true.
 */
export const IMAGE_PATTERN =
  /^[a-z0-9]+([._\-/][a-z0-9]+)*(:[\w][\w.\-]{0,127})?(@sha256:[a-f0-9]{64})?$/i;

/**
 * What a registry was willing to tell us about a reference.
 *
 * Four members, and only one of them puts anything on screen. `unavailable` is the warning;
 * everything else renders nothing, because a check that cannot answer must not be the
 * reason a spin-up did not happen.
 *
 * `unsupported` and `unknown` are kept apart even though they look identical to the user:
 * the first means the reference names a registry this app refuses to dereference and no
 * request was made, the second means one was made and did not settle. An operator reading
 * `image.checked` needs to tell those apart, and the SSRF assertion in the route's tests is
 * written against the first.
 */
export type ImageCheckStatus = "available" | "unavailable" | "unknown" | "unsupported";

/** A reference split the way a registry API wants it. */
export type ImageReference = {
  /** Normalized host. `docker.io` for a bare name; whatever was typed otherwise. */
  registry: string;
  /** Path only, no leading slash: `library/redis`, `owner/app`. */
  repository: string;
  /** A tag, or `sha256:…`. */
  reference: string;
};

/**
 * One path component of a repository, per the OCI distribution grammar.
 *
 * This is load-bearing beyond validation. Because a component cannot contain `.` on its
 * own, cannot contain `%`, and cannot be empty, `..`, `%2e%2e` and `//` are all
 * unrepresentable — so the repository can be interpolated into a manifest URL without
 * escaping, which it has to be: the `/` between components must stay a literal separator
 * and `encodeURIComponent` would eat it.
 */
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG = /^[\w][\w.-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** Docker Hub's own names for itself, plus the host its registry API actually answers on. */
const DOCKER_HUB_ALIASES = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
]);

/**
 * Splits a reference the way Docker does, or returns null.
 *
 * The one rule worth stating: **the first path component is a registry host if and only if
 * it contains a dot or a colon, or is exactly `localhost`.** That is Docker's own
 * disambiguation, and it is why `169.254.169.254/foo/bar` is a well-formed reference naming
 * a registry rather than a Docker Hub repository — the fact SECURITY.md and docs/limitations.md both
 * cite as the SSRF hazard in checking existence at all.
 *
 * This function does not resolve that hazard and must not try. It reports what the string
 * says; `registryFor` in ./registries decides which of three hosts, if any, may be
 * dereferenced. Keeping the two apart is what lets the parser be a pure function with a
 * table-driven test and the allowlist be a constant with no parsing in it.
 *
 * Null means "nothing here to check": a reference that is malformed, or one whose repository
 * path is not lowercase OCI. Never an error — this path never blocks a submit, and a
 * reference this cannot read is one the app simply says nothing about.
 */
export function parseImageReference(image: string): ImageReference | null {
  const trimmed = image.trim();
  if (!trimmed || !IMAGE_PATTERN.test(trimmed)) return null;

  /*
   * Four guards below are unreachable while IMAGE_PATTERN gates this function above — a
   * second `@`, an empty first component, a tag the pattern would have refused. They are
   * kept anyway, and the uncovered lines are the cost: this function is read on its own,
   * the pattern is the only thing standing between it and an arbitrary string, and a
   * loosening of that regex should not silently turn a repository into a host. Do not
   * remove one to make a coverage number rounder.
   */

  // Digest first, and it wins: `redis:7@sha256:…` is pinned by the digest, and the tag is
  // decoration Docker itself ignores.
  const [beforeDigest, digest, ...extraDigests] = trimmed.split("@");
  if (extraDigests.length > 0 || beforeDigest === undefined) return null;
  if (digest !== undefined && !DIGEST.test(digest)) return null;

  /*
   * The tag is stripped whether or not a digest was found, and that is the whole reason
   * this is not an `else`. `alpine:3.20@sha256:…` is legal and the digest wins — but the
   * `:3.20` still has to come off the repository, or the first path component becomes
   * `alpine:3.20`, which contains a colon, which makes it a registry host under the rule
   * below. A digest-pinned image would have been read as a reference to a registry named
   * after itself.
   *
   * A trailing colon is a tag only when what follows has no slash: `localhost:5000/app` is
   * a host and a port. That is the rule `repositoryOf` in ../presets.ts applies, and the
   * two are asserted to agree across the whole preset catalog.
   */
  let remainder = beforeDigest;
  let tag = "latest";
  const colon = remainder.lastIndexOf(":");
  if (colon !== -1 && !remainder.slice(colon + 1).includes("/")) {
    tag = remainder.slice(colon + 1);
    remainder = remainder.slice(0, colon);
    if (!TAG.test(tag)) return null;
  }

  // An untagged reference means `latest` to every registry, so it means it here too.
  const reference = digest ?? tag;

  const parts = remainder.split("/");
  const first = parts[0];
  if (first === undefined || first === "") return null;

  const hasHost = first.includes(".") || first.includes(":") || first === "localhost";
  const host = hasHost ? first.toLowerCase() : "docker.io";
  const pathParts = hasHost ? parts.slice(1) : parts;

  // A bare host with no path is not a reference to anything.
  if (pathParts.length === 0) return null;
  if (!pathParts.every((part) => PATH_COMPONENT.test(part))) return null;

  const registry = DOCKER_HUB_ALIASES.has(host) ? "docker.io" : host;
  // Docker Hub's official images live under `library/`, which nobody types.
  const repository =
    registry === "docker.io" && pathParts.length === 1
      ? `library/${pathParts[0]}`
      : pathParts.join("/");

  return { registry, repository, reference };
}
