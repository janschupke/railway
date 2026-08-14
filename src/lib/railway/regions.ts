import "server-only";

import { REGIONS } from "@/lib/constants";
import { listRegions } from "./api";
import type { RegionOption } from "./types";

/**
 * The region list, memoised, because nothing else on the dashboard carries it.
 *
 * `managedNames` costs no round trip because it reads through `loadContainers`, which the
 * page already pays for. This read shares nothing: `regions` is a root query with its own
 * request, `/dashboard` is `force-dynamic`, and the page re-renders on every
 * `router.refresh()` — so uncached, offering a region select would mean a Railway request
 * every few seconds, for a list of datacentres that changes about twice a year, against a
 * quota Railway documents at 1,000 an hour on Hobby.
 *
 * A process-global map with a TTL, on the same terms as lib/registry/probe.ts and
 * lib/idempotency.ts: per replica, reset by `next dev`'s module reloading, and honest
 * because this is a single-replica app that says so in the README. Nothing here is state the
 * app owns — losing the whole map costs one extra request.
 *
 * ADR-4 is untouched by it. That decision is about not mirroring Railway's state in a
 * database that can then disagree with it; this cannot disagree for longer than TTL_MS, and
 * a stale entry costs a region choice rather than a wrong answer about what exists.
 */
type CacheEntry = { regions: RegionOption[]; expiresAt: number };

const cache = new Map<string, CacheEntry>();

/** Test-only. The map outlives a test file otherwise, and one case would seed the next. */
export function __resetRegionCache(): void {
  cache.clear();
}

/*
 * Keyed by user as well as by project, unlike the registry's answer cache.
 *
 * That one is shared across users deliberately: every entry is an anonymous answer about a
 * public repository. This one is not. `regions(projectId)` is read with the caller's token
 * and Railway's own `Region` carries a `workspaceId`, so the list is not established to be
 * the same for two people looking at the same project — and keying by user costs one map
 * entry per person to remove the question entirely.
 */
const keyFor = (userId: string, projectId: string) => `${userId}:${projectId}`;

export async function cachedRegions(
  accessToken: string,
  userId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<RegionOption[]> {
  const key = keyFor(userId, projectId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.regions;
  // Expired rather than absent: dropped here so a read that then throws does not leave a
  // stale entry to be served for another ten minutes.
  if (hit) cache.delete(key);

  const regions = await listRegions(accessToken, projectId, signal);

  // Deleted first so a refreshed key moves to the back of the insertion order and the
  // eviction below stays oldest-written rather than oldest-read.
  cache.delete(key);
  cache.set(key, { regions, expiresAt: Date.now() + REGIONS.TTL_MS });

  while (cache.size > REGIONS.CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }

  return regions;
}
