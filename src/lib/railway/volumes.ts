/**
 * The volumes attached to an environment, and removing one.
 *
 * A read that degrades and a mutation that does not, in one file because a volume is only
 * ever discussed against the environment holding it.
 */

import "server-only";

import { gql, gqlPartial, logRefusals } from "./client";
import { ENVIRONMENT_VOLUMES_QUERY, VOLUME_DELETE_MUTATION } from "./operations";
import { nodes, toContainerVolumes } from "./mappers";
import type { ContainerVolume } from "./types";

/**
 * The volumes mounted in one environment, keyed by service.
 *
 * Two callers, wanting the same facts for different reasons. The dashboard reads it beside
 * the container list so a row can say where its data lives and the destroy dialog can offer
 * to take the data with it. `spinDown` reads it again, server-side, at the moment it acts —
 * because the browser is not trusted with a volume id any more than it is with ownership.
 *
 * Partial, and degrading: `EnvironmentVolumes` is in DEGRADING_OPERATIONS, so a refusal
 * answers `{}` rather than throwing. That is safe in both callers precisely because the
 * empty answer is the conservative one — no readout, no checkbox, and a destroy that keeps
 * the data and says so.
 *
 * One caveat with a real window on it: Railway lists a volume instance a few seconds after
 * `volumeCreate` returns (about three, measured). A container destroyed inside that window
 * has a volume this read cannot see yet, so the data is kept — which the toast states, so
 * the outcome is wrong-but-visible rather than silent. docs/limitations.md says so too.
 */
export async function getEnvironmentVolumes(
  accessToken: string,
  environmentId: string,
  signal?: AbortSignal,
): Promise<Record<string, ContainerVolume>> {
  const { data, errors } = await gqlPartial(
    ENVIRONMENT_VOLUMES_QUERY,
    { id: environmentId },
    { accessToken, signal },
  );

  // Also every dashboard render.
  logRefusals("railway.volumes.refused", { environment_id: environmentId }, errors);

  return toContainerVolumes(nodes(data?.environment?.volumeInstances));
}

/**
 * Delete a volume and everything written to it.
 *
 * Separate from `destroyContainer` rather than folded into it, and that is the shape of the
 * decision rather than a preference: Railway does not cascade — a `serviceDelete` leaves the
 * volume behind as billable storage, which was probed rather than assumed — so deleting the
 * data is a second act the user has to be offered. `spinDown` asks; this performs.
 *
 * Checks nothing itself, exactly as `destroyContainer` checks nothing. The guard is the
 * `MANAGED_PREFIX` re-derivation in its callers, and `local/mutation-inside-ownership-guard`
 * is what holds that property — a call graph no type defends. See ADR-14 for why a volume's
 * owner is the service it is mounted on.
 */
export async function deleteVolume(
  accessToken: string,
  volumeId: string,
  signal?: AbortSignal,
): Promise<void> {
  await gql(VOLUME_DELETE_MUTATION, { volumeId }, { accessToken, signal });
}
