/**
 * The regions a container can be created in.
 *
 * Its own module because it shares nothing with the reads beside it: no session token passed
 * down, no `cache()` memo, no degradation. `cachedRegions` owns the memoisation and the TTL,
 * and this is the request-scoped wrapper over it.
 */

import "server-only";

import { getSession } from "@/lib/auth/server";
import { cachedRegions } from "@/lib/railway/regions";
import { log } from "@/lib/logger";
import type { RegionOption } from "@/lib/railway/types";

/**
 * Where a container may be created, for the spin-up form's region select.
 *
 * Carries `managedNames`' contract above word for word: it cannot reject, and must not be
 * made to. The result crosses into a client component as an unawaited promise, and a
 * rejected one surfaces there as an error in the client tree rather than as a choice that
 * quietly did not appear — so everything is caught here, where the answer to a failure is a
 * designed one.
 *
 * `[]` is that designed answer rather than a failure: the select renders disabled with a
 * reason and Railway picks the region, which is what happened before this app offered a
 * choice at all. See DEGRADING_OPERATIONS in lib/railway/schema-policy.ts.
 *
 * Unlike `managedNames` it does not share `loadContainers`' memo — nothing else reads
 * regions — so it is the one read on this page with a cache of its own. See
 * lib/railway/regions.ts for why that cache exists and what it costs.
 */
export async function deployRegions(projectId: string): Promise<RegionOption[]> {
  try {
    const session = await getSession();
    if (!session) return [];
    return await cachedRegions(session.accessToken, session.user.id, projectId);
  } catch (error) {
    // Debug, beside the two reads above and for their reason: this runs on every render, and
    // a choice the app degrades out of by design is not an incident.
    log.debug("dashboard.regions_failed", { error });
    return [];
  }
}
