import "server-only";

import { REGISTRY } from "@/lib/constants";
import { parseImageReference, type ImageCheckStatus } from "./reference";
import { registryFor, type RegistryEndpoints, type RegistryId } from "./registries";

/**
 * Manifest media types this app will accept.
 *
 * All four, and the two list types are the load-bearing ones: ask for `manifest.v2` alone
 * and a multi-architecture image — which every preset in the catalog is — answers 404 or
 * 406, because the thing at that tag is an index rather than a manifest. A check that
 * reported "no such image" for `redis:7-alpine` would be worse than no check.
 */
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type CacheEntry = { status: ImageCheckStatus; expiresAt: number };

/*
 * Two process-global maps, and the usual caveats apply to both.
 *
 * Per replica, like the stream-slot counter in lib/stream-slots.ts, and honest for the same
 * reason: this is a single-replica app. Reset by `next dev`'s module reloading and not in
 * production. And there is exactly one copy of each, because src/proxy.ts does not import
 * this module — the two-instances-across-the-proxy-boundary hazard in architecture.md
 * applies to anything it does.
 *
 * The answer cache is deliberately shared across users rather than keyed per session. Every
 * entry is an anonymous answer about a public repository: there is nothing per-user in it,
 * so partitioning it would multiply this server's egress by the number of people typing the
 * same reference for no privacy gained.
 */
const answers = new Map<string, CacheEntry>();
const cooloffs = new Map<RegistryId, number>();

/** Test-only. Both maps outlive a test file otherwise, and one case would seed the next. */
export function __resetRegistryCache(): void {
  answers.clear();
  cooloffs.clear();
}

function readCache(key: string): ImageCheckStatus | null {
  const hit = answers.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    answers.delete(key);
    return null;
  }
  return hit.status;
}

function writeCache(key: string, status: ImageCheckStatus): void {
  const ttl = status === "unknown" ? REGISTRY.UNKNOWN_TTL_MS : REGISTRY.ANSWER_TTL_MS;
  // Delete first so a refreshed key moves to the back of the insertion order and the
  // eviction below stays least-recently-written rather than least-recently-read.
  answers.delete(key);
  answers.set(key, { status, expiresAt: Date.now() + ttl });

  while (answers.size > REGISTRY.CACHE_MAX_ENTRIES) {
    const oldest = answers.keys().next();
    if (oldest.done) break;
    answers.delete(oldest.value);
  }
}

const coolingOff = (id: RegistryId): boolean => {
  const until = cooloffs.get(id);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    cooloffs.delete(id);
    return false;
  }
  return true;
};

/**
 * An anonymous pull token.
 *
 * Taken for all three registries rather than only on a 401. quay.io serves public manifests
 * unauthenticated and the other two never do, so asking every time costs quay one extra
 * request and removes a branch — and quay is not the registry whose limits this app is
 * careful about.
 *
 * `null` distinguishes "the registry refused to scope a token to this repository" from "the
 * token endpoint failed", because ghcr.io answers the first with 403 DENIED and never lets
 * the manifest request happen at all. That is its way of saying a package does not exist.
 */
async function fetchToken(
  registry: RegistryEndpoints,
  repository: string,
  signal: AbortSignal,
): Promise<{ token: string } | { refused: true } | null> {
  const url = new URL(registry.tokenUrl);
  url.searchParams.set("service", registry.service);
  url.searchParams.set("scope", `repository:${repository}:pull`);

  const response = await fetch(url, {
    signal,
    cache: "no-store",
    redirect: "manual",
    headers: { accept: "application/json" },
  });

  if (response.status === 401 || response.status === 403) return { refused: true };
  if (!response.ok) return null;

  const body: unknown = await response.json();
  const token =
    typeof body === "object" && body !== null && "token" in body
      ? (body as { token: unknown }).token
      : undefined;
  return typeof token === "string" && token ? { token } : null;
}

/**
 * Whether a registry will show us a manifest for this reference.
 *
 * Four outcomes, and the mapping is the whole design. It was settled by probing the three
 * registries rather than by reading the spec, because the spec does not say what any of
 * this means in practice:
 *
 *   - **200 → available.** HEAD only, never GET: a GET decrements Docker Hub's anonymous
 *     pull budget and a HEAD does not (measured; see the REGISTRY group in lib/constants.ts).
 *   - **404 → unavailable.** The one clean negative the OCI API gives, and it means exactly
 *     "no such tag on a repository you can read".
 *   - **401 or 403 → unavailable.** A repository that does not exist and a repository that
 *     is private are the same answer on all three registries — Docker Hub issues a token
 *     with an empty `access` claim and then refuses with `insufficient_scope`, ghcr.io
 *     refuses at the token endpoint with DENIED, quay.io 401s with a challenge. There is no
 *     registry-API way to tell them apart, and this app does not need one: it collects no
 *     registry credentials, so a private image fails to deploy exactly as an absent one
 *     does. One sentence covers both.
 *   - **anything else → unknown**, and unknown renders nothing. 429, 5xx, a timeout, a DNS
 *     failure, an unreadable body — a registry having a bad day must never be the reason a
 *     spin-up did not happen.
 *
 * A **3xx is unknown**, not a redirect to follow. This is the one place a registry response
 * could still choose a URL for us, so it does not get to: `redirect: "manual"` on both
 * requests, and a `location` is never read. Manifest HEADs do not legitimately redirect —
 * blob GETs do, and this makes none. It also means the bearer token is never re-sent to
 * somewhere it was not minted for.
 *
 * No retries either, deliberately, where `lib/railway/client.ts` has a three-attempt ladder.
 * That ladder exists for a mutation a person is waiting on. Here a second attempt doubles
 * this server's egress to change nothing on screen, and against a rate limit it is the
 * failure this whole feature was nearly not built to avoid.
 */
export async function checkImage(
  image: string,
  signal?: AbortSignal,
): Promise<{ status: ImageCheckStatus; cached: boolean; registry: string }> {
  const parsed = parseImageReference(image);
  // The route has already applied IMAGE_PATTERN, so this is a guard rather than a path.
  if (!parsed) return { status: "unsupported", cached: false, registry: "none" };

  const registry = registryFor(parsed.registry);
  if (!registry) return { status: "unsupported", cached: false, registry: "other" };

  const key = `${parsed.registry}/${parsed.repository}:${parsed.reference}`;
  const cached = readCache(key);
  if (cached) return { status: cached, cached: true, registry: registry.id };

  if (coolingOff(registry.id)) {
    return { status: "unknown", cached: false, registry: registry.id };
  }

  const status = await probe(registry, parsed.repository, parsed.reference, signal);

  // An abort is the caller hanging up, not an answer, and caching it would hold `unknown`
  // over a reference nothing ever actually asked about.
  if (!signal?.aborted) writeCache(key, status);

  return { status, cached: false, registry: registry.id };
}

async function probe(
  registry: RegistryEndpoints,
  repository: string,
  reference: string,
  signal: AbortSignal | undefined,
): Promise<ImageCheckStatus> {
  // One deadline over both requests. Composed the way lib/railway/client.ts composes its
  // own — the idiom is reusable, that client is not: it takes no arbitrary URL, correctly.
  const timeout = AbortSignal.timeout(REGISTRY.PROBE_TIMEOUT_MS);
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const auth = await fetchToken(registry, repository, composed);
    if (auth === null) return "unknown";
    if ("refused" in auth) return "unavailable";

    /*
     * The repository is interpolated rather than encoded, and that is required rather than
     * sloppy: the `/` between path components must stay a separator, so
     * encodeURIComponent would break every namespaced image. What makes it safe is the
     * grammar in ./reference.ts — a component cannot contain `%`, `?`, `#` or a bare dot,
     * so `..` and an encoded traversal are both unrepresentable by construction.
     */
    const response = await fetch(
      `${registry.manifestBase}/v2/${repository}/manifests/${reference}`,
      {
        method: "HEAD",
        signal: composed,
        cache: "no-store",
        redirect: "manual",
        headers: { accept: ACCEPT, authorization: `Bearer ${auth.token}` },
      },
    );

    if (response.status === 200) return "available";
    if (response.status === 404) return "unavailable";
    if (response.status === 401 || response.status === 403) return "unavailable";
    if (response.status === 429) {
      cooloffs.set(registry.id, Date.now() + REGISTRY.COOLOFF_MS);
      return "unknown";
    }
    return "unknown";
  } catch {
    /*
     * Swallowed rather than reported, and this is the one place in the app where that is
     * right. `reportError` exists to turn a failure into something a user is told; there is
     * nothing to tell here, because every failure renders the same nothing. Naming the
     * cause would also put registry-authored text on a path towards the browser, which
     * security.md rules out. The route logs the outcome; that is the record.
     */
    return "unknown";
  }
}
