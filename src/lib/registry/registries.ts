import "server-only";

import { env } from "@/env";

export type RegistryId = "docker.io" | "ghcr.io" | "quay.io";

export type RegistryEndpoints = {
  id: RegistryId;
  /** Origin of the OCI distribution API. Manifests hang off `/v2/`. */
  manifestBase: string;
  /** Where an anonymous pull token is minted. */
  tokenUrl: string;
  /** The `service` parameter that endpoint wants. */
  service: string;
};

/**
 * Every host this subsystem is willing to talk to, and the only place a new one may be
 * added.
 *
 * These four strings are the entire SSRF control, and the shape of the control is worth
 * stating precisely, because docs/limitations.md spends a paragraph explaining why the naive version
 * could not be built. `IMAGE_PATTERN` admits a bare host as the first component, and
 * Docker's own rules make a first component containing a dot a registry — so
 * `169.254.169.254/foo/bar` is a *valid reference* that names a registry. `parseImageReference`
 * reports that faithfully. What closes the hazard is that `registryFor` then returns null
 * for it: the app refuses to map it to a base URL, rather than resolving the address and
 * inspecting what came back.
 *
 * The consequence, and the claim SECURITY.md makes: **no host, port or scheme in this
 * subsystem is derived from user input, or from a registry response.** User input only ever
 * becomes a path segment and a query value against one of these four constants.
 *
 * The second half of that sentence is why the token URL is here rather than read from a
 * `WWW-Authenticate` challenge, which is how the OCI spec says to find it. A `realm` is a
 * URL chosen by whatever answered, which for a subsystem whose whole job is not to
 * dereference chosen URLs is the one thing not to follow. There are three registries; their
 * realms were verified once and written down. A 401 is now only a signal that the fixed
 * token step is needed, never a destination.
 *
 * Adding a fourth entry is a new outbound host, which SECURITY.md's own checklist says is a
 * change to that document.
 */
const DEFAULTS: Record<RegistryId, RegistryEndpoints> = {
  // Docker Hub's registry API does not answer on docker.io; registry-1 is where /v2/ lives.
  "docker.io": {
    id: "docker.io",
    manifestBase: "https://registry-1.docker.io",
    tokenUrl: "https://auth.docker.io/token",
    service: "registry.docker.io",
  },
  "ghcr.io": {
    id: "ghcr.io",
    manifestBase: "https://ghcr.io",
    tokenUrl: "https://ghcr.io/token",
    service: "ghcr.io",
  },
  "quay.io": {
    id: "quay.io",
    manifestBase: "https://quay.io",
    tokenUrl: "https://quay.io/v2/auth",
    service: "quay.io",
  },
};

/** Exported for the test that asserts every default is https and for env coverage. */
export const REGISTRY_DEFAULTS: Readonly<Record<RegistryId, RegistryEndpoints>> =
  DEFAULTS;

const isRegistryId = (host: string): host is RegistryId =>
  Object.prototype.hasOwnProperty.call(DEFAULTS, host);

/**
 * The endpoints for a normalized registry host, or null if it is not one of the three.
 *
 * Null is the refusal, and it is the only one. Callers must treat it as "say nothing about
 * this reference" rather than "this reference is wrong" — a private registry is a
 * legitimate thing to type into the form, and this app simply has no opinion on it.
 *
 * `REGISTRY_PROBE_URL` relocates all three at once. It cannot add a fourth: the lookup above
 * still runs first, so an unlisted host is refused whether the override is set or not.
 */
export function registryFor(host: string): RegistryEndpoints | null {
  if (!isRegistryId(host)) return null;

  const base = DEFAULTS[host];
  const override = env().REGISTRY_PROBE_URL;
  if (!override) return base;

  const origin = override.replace(/\/+$/, "");
  return { ...base, manifestBase: origin, tokenUrl: `${origin}/token` };
}
