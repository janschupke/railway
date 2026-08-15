/**
 * What this app remembers about a registry: an answer about an image, and whether a
 * registry is currently being left alone.
 *
 * Two process-global maps and the state machine over them, with no network in it. They were
 * interleaved with `checkImage`'s HTTP code in `probe.ts`, which meant the TTL split, the
 * eviction order and the cool-off window could only be exercised by standing up a fake
 * registry and counting requests — about 190 lines of `probe.integration.test.ts` existed to
 * reach behaviour that never touches a socket.
 *
 * The usual caveats apply to both maps. Per replica, like the stream-slot counter in
 * lib/stream-slots.ts and for the same reason (docs/limitations.md). Reset by `next dev`'s
 * module reloading and not in production. And there is exactly one copy of each, because
 * src/proxy.ts does not import this module — the two-instances-across-the-proxy-boundary
 * hazard in architecture.md applies to anything it does.
 *
 * The answer cache is deliberately shared across users rather than keyed per session. Every
 * entry is an anonymous answer about a public repository: there is nothing per-user in it, so
 * partitioning it would multiply this server's egress by the number of people typing the same
 * reference for no privacy gained. `lib/railway/regions.ts` keys its cache by user for
 * exactly the opposite reason, and says so.
 */

import { REGISTRY } from "@/lib/constants";
import type { ImageCheckStatus } from "./reference";
import type { RegistryId } from "./registries";

type CacheEntry = { status: ImageCheckStatus; expiresAt: number };

const answers = new Map<string, CacheEntry>();
const cooloffs = new Map<RegistryId, number>();

/** Test-only. Both maps outlive a test file otherwise, and one case would seed the next. */
export function __resetRegistryCache(): void {
  answers.clear();
  cooloffs.clear();
}

export function readCache(key: string): ImageCheckStatus | null {
  const hit = answers.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    answers.delete(key);
    return null;
  }
  return hit.status;
}

/**
 * Remember an answer, for longer when the registry actually gave one.
 *
 * `unknown` means this app could not reach a verdict — a timeout, a refusal, a registry
 * cooling off — and holding that for the full answer TTL would keep an image marked
 * unverifiable long after the registry recovered.
 */
export function writeCache(key: string, status: ImageCheckStatus): void {
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

/** Whether a registry is inside the window opened by `startCoolOff`. */
export function coolingOff(id: RegistryId): boolean {
  const until = cooloffs.get(id);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    cooloffs.delete(id);
    return false;
  }
  return true;
}

/** Stop asking a registry that has just failed us, for REGISTRY.COOLOFF_MS. */
export function startCoolOff(id: RegistryId): void {
  cooloffs.set(id, Date.now() + REGISTRY.COOLOFF_MS);
}
