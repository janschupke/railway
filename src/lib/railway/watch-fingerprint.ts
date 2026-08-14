import "server-only";

import { createHash } from "node:crypto";
import type { Container } from "./types";

/**
 * What counts as a change worth refreshing the dashboard for.
 *
 * Built from the mapped Container list rather than the raw GraphQL body: the mapper
 * already decides what the dashboard renders, so anything it drops cannot be a visible
 * change and has no business waking a tab.
 *
 * `updatedAt` is deliberately EXCLUDED. Railway bumps it on every deployment tick, so
 * including it would mean a refresh every interval for the whole of a build — a window
 * the row's own deployment stream already owns and already refreshes at the end of. Each
 * false positive costs two Railway round trips, because /dashboard is force-dynamic.
 *
 * The cost of that choice, stated plainly: redeploying the same image to the same state
 * changes only `updatedAt`, and this will not notice it. See ADR-10.
 *
 * `deployedAt` is excluded for a different reason: it is redundant. It changes at exactly
 * the moment `deploymentId` does, and that is already here — so adding it would buy nothing
 * and leave one more field whose fluctuation the next reader has to reason about.
 *
 * Metric values are not excluded here because they never arrive here at all. They are not
 * on `Container`, which is the whole point of keeping them off it — see ContainerMetrics.
 *
 * `url` is INCLUDED, and it is the field that shows what the `updatedAt` rule is actually
 * about. Both are values this app does not control, and the difference is not how important
 * they are but how often they move: Railway rewrites `updatedAt` on every tick of a build,
 * while a service domain is minted once and then reads identically forever. So the URL costs
 * nothing per poll and buys the one case a watcher exists for — the tab that did NOT submit
 * the action, and would otherwise show a container with no address until its next full
 * navigation.
 *
 * Sorted after formatting, so Railway reordering its own `edges` is not a change.
 * Hashed rather than kept verbatim, so a watcher's memory is 28 bytes whatever the size
 * of the project.
 */
export function fingerprint(containers: Container[]): string {
  const rows = containers
    .map((container) =>
      [
        container.serviceId,
        container.rawName,
        container.image ?? "",
        container.repo ?? "",
        container.state,
        container.deploymentId ?? "",
        container.url ?? "",
      ].join(""),
    )
    .sort();

  return createHash("sha1").update(rows.join("")).digest("base64");
}
