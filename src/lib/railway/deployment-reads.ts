import "server-only";

import { STREAM } from "@/lib/constants";
import { log } from "@/lib/logger";
import { gql, gqlPartial } from "./client";
import {
  BUILD_LOGS_QUERY,
  DEPLOYMENT_EVENTS_QUERY,
  DEPLOYMENT_LOGS_QUERY,
  DEPLOYMENT_QUERY,
} from "./operations";
import { pickFailureReason, type DeploymentFailure } from "./failure-reason";
import { nodes } from "./mappers";
import type { LogLine } from "./types";

/**
 * The three reads a deployment monitor makes: its status, why it failed, and its log
 * history.
 *
 * Split from api.ts because they answer to a different consumer and to a different cost
 * profile. Everything left there is called once per render or once per click, from the
 * dashboard's loader or from a Server Action; these run for the life of an open stream,
 * and `deployment-monitor.ts` is their only caller.
 */

export async function getDeployment(
  accessToken: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<{ id: string; status: string | null; updatedAt: string | null } | null> {
  const data = await gql(
    DEPLOYMENT_QUERY,
    { id: deploymentId },
    { accessToken, signal },
  );
  return data.deployment;
}

/**
 * Why a deployment failed, from the one place Railway keeps it.
 *
 * Read once, when a deployment has already settled as FAILED, and never from the poll
 * loop — see DEPLOYMENT_EVENTS_QUERY for what a withdrawable field in that loop costs.
 *
 * `gqlPartial` rather than `gql`, which is the one non-obvious choice here. Railway
 * refuses a field it does not permit with HTTP 200, an `errors[]` entry and the field
 * nulled; `gql` throws on that and would discard the `step` that did arrive alongside it.
 * Keeping the partial answer is the whole reason gqlPartial exists.
 *
 * Transport, rate-limit and 5xx failures still throw out of here, because `execute` throws
 * before this returns. That is deliberate: every other read in this file throws, and the
 * monitor's catch is where "best effort" is actually spelled out — one closure away from
 * the identical catch on the log fallback.
 */
export async function getDeploymentFailure(
  accessToken: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<DeploymentFailure | null> {
  const { data, errors } = await gqlPartial(
    DEPLOYMENT_EVENTS_QUERY,
    { id: deploymentId, last: STREAM.FAILURE_EVENTS },
    { accessToken, signal },
  );

  for (const error of errors) {
    /*
     * Debug, not warn. This runs while the user is already looking at a failure, and a
     * feed the token cannot read is a capability this app degrades out of rather than an
     * incident — a warn per failed deployment would train people to ignore warns.
     */
    log.debug("railway.deployment.failure_reason_refused", {
      deployment_id: deploymentId,
      error,
    });
  }

  const failure = pickFailureReason(
    nodes(data?.deploymentEvents),
    STREAM.FAILURE_REASON_MAX,
  );

  /*
   * The reason text is deliberately NOT logged, only its length.
   *
   * It is unbounded and partly container-authored — a PRE_DEPLOY_COMMAND or HEALTHCHECK
   * payload can carry the container's own output — so it is exactly the unbounded label
   * the logging rules keep out of a log store. Unlike a redacted upstream error there is
   * no incident-id join to preserve either: the user can read the text on their own
   * screen, which is the point of the ticket.
   */
  log.debug("railway.deployment.failure_reason", {
    deployment_id: deploymentId,
    step: failure?.step ?? null,
    reason_length: failure?.reason?.length ?? 0,
  });

  return failure;
}

/**
 * Backfill for the log pane, used on first attach and after a stream reconnect so a
 * dropped connection does not leave a hole in the output.
 */
export async function getLogs(
  accessToken: string,
  deploymentId: string,
  kind: "build" | "deploy",
  limit: number = STREAM.BACKFILL_LINES,
  signal?: AbortSignal,
): Promise<LogLine[]> {
  /*
   * Branched rather than one call with a computed field name, which is what the old
   * `Record<string, LogLine[] | null>` was buying. The two documents have two result types
   * now — `{ buildLogs }` and `{ deploymentLogs }` — and a union of them has no property in
   * common, so a computed key cannot be read off it. Two lines that each name their own
   * field is the trade, and it is the same trade the monitor makes one layer up.
   */
  if (kind === "build") {
    const data = await gql(
      BUILD_LOGS_QUERY,
      { deploymentId, limit },
      { accessToken, signal },
    );
    // `?? []` although the schema says `[Log!]!`: a Railway that answered null here without
    // an errors[] entry would reach the log pane as a null array, and a backfill that
    // returns nothing is the designed empty state.
    return data.buildLogs ?? [];
  }

  const data = await gql(
    DEPLOYMENT_LOGS_QUERY,
    { deploymentId, limit },
    { accessToken, signal },
  );
  return data.deploymentLogs ?? [];
}
