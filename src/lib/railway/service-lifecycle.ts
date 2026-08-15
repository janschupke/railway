/**
 * Deploying, stopping, restarting, rolling back and destroying a service.
 *
 * The verbs that act on a container's current deployment rather than on its definition, plus
 * the history read that `rollbackDeployment` checks a posted id against — which is here, and
 * not with the other reads, because that check is what makes the rollback safe.
 */

import "server-only";

import { LIST } from "@/lib/constants";
import { gql, gqlPartial, logRefusals } from "./client";
import {
  DEPLOYMENTS_QUERY,
  DEPLOYMENT_RESTART_MUTATION,
  DEPLOYMENT_ROLLBACK_MUTATION,
  DEPLOYMENT_STOP_MUTATION,
  SERVICE_DELETE_MUTATION,
  SERVICE_DEPLOY_MUTATION,
} from "./operations";
import { nodes, toDeploymentHistory } from "./mappers";
import type { DeploymentHistoryEntry } from "./types";

/**
 * Deploy a service instance, and hand back the id of the deployment that starts.
 *
 * Two callers, and they are the same operation seen from either end of a container's life:
 * `createContainer` above sends it to start a service that has just been registered, and
 * the redeploy action sends it to start one that is stopped, failed, or was created and
 * never deployed. That last case is why this is the app's only redeploy path —
 * `deploymentRedeploy` takes a deployment id, and the orphan a refused first deploy leaves
 * behind has none. See DEPLOYMENT_RESTART_MUTATION for the rest of that argument.
 *
 * Uncaught here on purpose: `createContainer` has to distinguish "no service exists" from
 * "a billable service exists and is not running", and the action has a different sentence
 * again. Both catch what suits them.
 */
export async function deployService(
  accessToken: string,
  params: { serviceId: string; environmentId: string },
  signal?: AbortSignal,
): Promise<string | null> {
  const deployed = await gql(
    SERVICE_DEPLOY_MUTATION,
    { serviceId: params.serviceId, environmentId: params.environmentId },
    { accessToken, signal },
  );
  /*
   * `?? null` on a field the schema calls `String!`, kept deliberately. This value is the
   * id the row's log stream keys on, and the whole point of preferring
   * `serviceInstanceDeployV2` over `serviceInstanceDeploy` was getting an id back — a
   * Railway that answered null anyway would take the stream down at the first property
   * access rather than degrade to "no logs for this deployment".
   */
  return deployed.serviceInstanceDeployV2 ?? null;
}

/**
 * Stop a running deployment. The service, its variables and its history survive.
 *
 * Takes a deployment id the caller read back from Railway rather than one a browser sent —
 * the ownership check in the action is what makes that true, and it is the same rule
 * `destroyContainer` sits behind.
 */
export async function stopDeployment(
  accessToken: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<void> {
  await gql(DEPLOYMENT_STOP_MUTATION, { id: deploymentId }, { accessToken, signal });
}

/** Restart a deployment's container in place, keeping the deployment and its log stream. */
export async function restartDeployment(
  accessToken: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<void> {
  await gql(DEPLOYMENT_RESTART_MUTATION, { id: deploymentId }, { accessToken, signal });
}

/**
 * One service's recent deployments, newest first — what the rollback control chooses from.
 *
 * Here rather than in deployment-reads.ts, on that file's own test: these run for the life of
 * an open stream, this runs once when someone opens a panel or presses a button.
 *
 * **Partial, and degrading.** `Deployments` is in DEGRADING_OPERATIONS, so a refusal comes
 * back as no entries rather than a throw. That is what makes it safe for `rollback` to check
 * a posted deployment id against this list: a refused read yields no members, so it refuses,
 * and the failure mode is a rollback that does not happen rather than one aimed at an id
 * nobody verified.
 *
 * **`refused` is returned beside the entries, and collapsing the two was a real defect.**
 * A refusal and a service that has genuinely never deployed both produce an empty list, and
 * the panel has a different sentence for each — one says the history could not be read, the
 * other says Railway has none. With only the array to go on, the panel told anyone whose
 * token cannot make this read that their service had never deployed, which is both wrong and
 * unactionable. The caller that does not care may ignore the flag; `rollback` is one, because
 * both cases mean the same thing to it.
 *
 * The shape and the newest-first sort are `toDeploymentHistory`'s, beside every other mapping
 * of a Railway response. The ordering is not trusted from the connection: `last` is asked for
 * on the strength of the one thing this app has observed about Railway's Relay ordering —
 * DEPLOYMENT_EVENTS_QUERY — and `pnpm probe:deployments` is what checks that against the live
 * API.
 */
export async function listServiceDeployments(
  accessToken: string,
  params: { projectId: string; environmentId: string; serviceId: string },
  signal?: AbortSignal,
): Promise<{ entries: DeploymentHistoryEntry[]; refused: boolean }> {
  const { data, errors } = await gqlPartial(
    DEPLOYMENTS_QUERY,
    {
      input: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        serviceId: params.serviceId,
      },
      last: LIST.DEPLOYMENT_HISTORY,
    },
    { accessToken, signal },
  );

  // Once per opened panel, and only the service id.
  logRefusals("railway.deployments.refused", { service_id: params.serviceId }, errors);

  return {
    entries: toDeploymentHistory(nodes(data?.deployments)),
    refused: errors.length > 0,
  };
}

/**
 * Roll a service back to one of its earlier deployments.
 *
 * The deployment id is the one value in this app that a browser posts and the server does not
 * read off the container first — a rollback target is by definition historical, so there is no
 * "current" field to take it from. `rollback` in action-deploy.ts closes that by re-reading
 * `listServiceDeployments` for the service the ownership guard just proved, and refusing an id
 * that is not one of its own. Checks nothing itself, exactly as `stopDeployment` checks
 * nothing; the guard is the caller's, and the lint rules are what hold it there.
 */
export async function rollbackDeployment(
  accessToken: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<void> {
  await gql(
    DEPLOYMENT_ROLLBACK_MUTATION,
    { id: deploymentId },
    { accessToken, signal },
  );
}

export async function destroyContainer(
  accessToken: string,
  serviceId: string,
  signal?: AbortSignal,
): Promise<void> {
  await gql(SERVICE_DELETE_MUTATION, { id: serviceId }, { accessToken, signal });
}
