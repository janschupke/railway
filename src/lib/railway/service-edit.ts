/**
 * Changing a container that already exists, and reading what variables it has.
 *
 * The read is here rather than with the other reads because it exists for the edit form and
 * for nothing else, and because the two share the one rule that shapes both: a variable name
 * the schema refuses on the way in is a name there is no point offering a row for on the way
 * out.
 */

import "server-only";

import { log } from "@/lib/logger";
// The one rule this layer shares with the form: a name the schema refuses on the way in is
// a name there is no point drawing a row for on the way out.
import { RESERVED_VARIABLE_PREFIX } from "@/lib/validation/patterns";
import { gql } from "./client";
// An edit is not live until it is deployed, so the update ends by calling the same verb a
// redeploy does.
import { deployService } from "./service-lifecycle";
import {
  SERVICE_INSTANCE_UPDATE_MUTATION,
  SERVICE_UPDATE_MUTATION,
  SERVICE_VARIABLES_QUERY,
  VARIABLE_COLLECTION_UPSERT_MUTATION,
  VARIABLE_DELETE_MUTATION,
} from "./operations";

/**
 * The names of the variables a service owns — names, and never values.
 *
 * The return type is the security property, not a convenience. Everything reachable from
 * here runs on the server, and the one thing the edit form needs is which rows to draw; a
 * function that handed back the map would put a generated database password one `return`
 * away from a browser. So the values are read, used to answer a question, and dropped
 * inside this function. See SECURITY.md, "Input surfaces".
 *
 * Two filters, and they refuse different things:
 *
 *   - **Shared variables.** Railway resolves a service against the environment's shared set,
 *     and those are not this service's to edit — see SERVICE_VARIABLES_QUERY. Subtracted by
 *     name *and* value, because a service may override a shared name with its own value and
 *     that override is genuinely the service's.
 *   - **The `RAILWAY_` namespace.** Railway injects its own block, and `validation/schemas.ts`
 *     refuses those names on the way back in. Listing them would be drawing rows the form
 *     cannot submit.
 */
export async function readServiceVariableNames(
  accessToken: string,
  params: { projectId: string; environmentId: string; serviceId: string },
  signal?: AbortSignal,
): Promise<string[]> {
  const data = await gql(
    SERVICE_VARIABLES_QUERY,
    {
      projectId: params.projectId,
      environmentId: params.environmentId,
      serviceId: params.serviceId,
    },
    { accessToken, signal },
  );

  const shared = data.shared ?? {};
  return Object.entries(data.service ?? {})
    .filter(([name, value]) => !(name in shared && shared[name] === value))
    .map(([name]) => name)
    .filter((name) => !name.toUpperCase().startsWith(RESERVED_VARIABLE_PREFIX))
    .sort();
}

/**
 * Change an existing service: its name, its image, its environment, or any combination.
 *
 * Four upstream calls, and which of them run depends on what actually changed — the caller
 * has already diffed against Railway's own answer, so an edit that touches only the name
 * sends one mutation and no deploy.
 *
 * The ordering is not arbitrary:
 *
 *   1. **Rename**, because it is the only step that cannot affect what the container runs.
 *      What arrives here has already been through `toManagedName`; this layer does not
 *      re-derive ownership and must never be given a name that did not (ADR-5).
 *   2. **Image**, which is the edit people came for.
 *   3. **Variables** — deletions first, then the upsert. Before the deploy for the reason
 *      `createContainer` gives at length: a database that loses the variable it boots on
 *      restarts forever, and the user watches a crash loop this app caused.
 *   4. **Deploy**, once, and only when step 2 or 3 ran. A rename changes nothing about the
 *      running container, so redeploying for one would be a rebuild nobody asked for.
 *
 * Steps 1 and 2 throw. Nothing about the service has changed when they fail, so the honest
 * answer is the error and a form the user can resubmit. Steps 3 and 4 are caught and
 * returned, exactly as in `createContainer`, because by then the service *has* changed and a
 * throw would lose which half succeeded.
 *
 * A partial edit is therefore possible: rename applied, image refused. That is stated rather
 * than defended against — the refreshed list is what the row shows either way, so the user
 * sees what actually landed rather than what was asked for.
 */
export async function updateContainer(
  accessToken: string,
  params: {
    projectId: string;
    environmentId: string;
    serviceId: string;
    /** Already prefixed by the caller via toManagedName(). Absent when unchanged. */
    name?: string;
    /** Absent when unchanged. */
    image?: string;
    /** Names to set, already merged and validated. Absent when nothing is being set. */
    variables?: Record<string, string>;
    /** Names the editor no longer lists, removed one at a time. */
    removeVariables?: string[];
  },
  signal?: AbortSignal,
): Promise<{
  deploymentId: string | null;
  /**
   * What happened, in the same register `createContainer` uses.
   *
   * `unchanged` is a real outcome rather than an error: a form submitted with nothing edited
   * is a thing people do, and it costs one read and no mutation.
   */
  outcome: "unchanged" | "updated" | "deployed" | "variables_failed" | "deploy_failed";
}> {
  const { projectId, environmentId, serviceId } = params;
  const removals = params.removeVariables ?? [];
  const hasVariableWork =
    removals.length > 0 || Object.keys(params.variables ?? {}).length > 0;

  if (params.name === undefined && params.image === undefined && !hasVariableWork) {
    return { deploymentId: null, outcome: "unchanged" };
  }

  if (params.name !== undefined) {
    await gql(
      SERVICE_UPDATE_MUTATION,
      { id: serviceId, input: { name: params.name } },
      { accessToken, signal },
    );
  }

  if (params.image !== undefined) {
    await gql(
      SERVICE_INSTANCE_UPDATE_MUTATION,
      { serviceId, environmentId, input: { source: { image: params.image } } },
      { accessToken, signal },
    );
  }

  if (hasVariableWork) {
    try {
      /*
       * Deletions before the upsert, so a row renamed in the editor — old name dropped, new
       * name added — cannot have its delete land after its write.
       */
      for (const name of removals) {
        await gql(
          VARIABLE_DELETE_MUTATION,
          { input: { projectId, environmentId, serviceId, name } },
          { accessToken, signal },
        );
      }

      if (params.variables && Object.keys(params.variables).length > 0) {
        await gql(
          VARIABLE_COLLECTION_UPSERT_MUTATION,
          {
            input: {
              projectId,
              environmentId,
              serviceId,
              variables: params.variables,
              /*
               * `replace: false` even here, where the service does have variables to
               * replace. Removal is `variableDelete` per name — see VARIABLE_DELETE_MUTATION
               * — so `replace: true` would only add the power to delete something the read
               * failed to report, which is the failure mode with no way back.
               */
              replace: false,
              // The deploy below is the one this app tracks. Same argument as createContainer.
              skipDeploys: true,
            },
          },
          { accessToken, signal },
        );
      }
    } catch (error) {
      /*
       * Counts, never names or values. The names here are a merge of catalog defaults and
       * rows a person typed, so they are neither closed nor bounded — the same reason the
       * rejected deploymentId is not logged.
       */
      log.warn("railway.variables_failed", {
        service_id: serviceId,
        variable_count: Object.keys(params.variables ?? {}).length,
        removed_count: removals.length,
        error,
      });
      return { deploymentId: null, outcome: "variables_failed" };
    }
  }

  if (params.image === undefined && !hasVariableWork) {
    // Renamed and nothing else. Nothing to redeploy, and nothing new to stream.
    return { deploymentId: null, outcome: "updated" };
  }

  let deploymentId: string | null;
  try {
    deploymentId = await deployService(
      accessToken,
      { serviceId, environmentId },
      signal,
    );
  } catch (error) {
    log.warn("railway.deploy_failed", { service_id: serviceId, error });
    return { deploymentId: null, outcome: "deploy_failed" };
  }

  return { deploymentId, outcome: "deployed" };
}
