import "server-only";

import { METRICS, STREAM } from "@/lib/constants";
import { log } from "@/lib/logger";
// The one rule this layer shares with the form: a name the schema refuses on the way in is
// a name there is no point drawing a row for on the way out.
import { RESERVED_VARIABLE_PREFIX } from "@/lib/validation";
import { gql, gqlPartial } from "./client";
import { RailwayApiError } from "./errors";
import {
  BUILD_LOGS_QUERY,
  DEPLOYMENT_EVENTS_QUERY,
  DEPLOYMENT_LOGS_QUERY,
  DEPLOYMENT_QUERY,
  DEPLOYMENT_RESTART_MUTATION,
  DEPLOYMENT_STOP_MUTATION,
  ENVIRONMENT_CREATE_MUTATION,
  PROJECTS_PERSONAL_QUERY,
  PROJECTS_WORKSPACE_QUERY,
  PROJECT_CREATE_MUTATION,
  PROJECT_METRICS_QUERY,
  PROJECT_QUERY,
  SERVICE_CREATE_MUTATION,
  SERVICE_DELETE_MUTATION,
  SERVICE_DEPLOY_MUTATION,
  SERVICE_INSTANCE_UPDATE_MUTATION,
  SERVICE_UPDATE_MUTATION,
  SERVICE_VARIABLES_QUERY,
  VARIABLE_COLLECTION_UPSERT_MUTATION,
  VARIABLE_DELETE_MUTATION,
} from "./operations";
import { pickFailureReason, type DeploymentFailure } from "./failure-reason";
/*
 * The node types are gone from this file's imports and that absence is the ticket.
 * `gql<{ project: ProjectNode & { services: Edges<ServiceNode> } }>` used to restate, by
 * hand, the shape of a document written thirty lines away; the shapes now arrive with the
 * documents. What is left is the mapper functions and `ViewerNode`, which is a merged
 * domain type rather than a claim about any one response.
 */
import {
  nodes,
  toContainerMetrics,
  toContainers,
  toProject,
  toProjects,
  toWorkspaceSpend,
  type ViewerNode,
} from "./mappers";
import type {
  Container,
  ContainerMetrics,
  LogLine,
  RailwayEnvironment,
  RailwayProject,
  WorkspaceSpend,
} from "./types";
import type { Refusable, TypedDocument } from "./typed-document";

export type Viewer = { id: string; name?: string; email?: string };

/** A project source that answered, or the reason it did not. */
type SourceResult = {
  /** Names the source in the log and in the partial-failure notice. */
  name: "personal" | "workspace";
  viewer: ViewerNode | null;
  error: RailwayApiError | null;
};

/**
 * Every project the signed-in user can reach, merged from each source that answered.
 *
 * Railway exposes projects in more than one place and an OAuth token's view of each is
 * not documented — a project plainly visible in Railway's own dashboard can come back
 * from either, both, or neither. They are read as independent requests so that a source
 * the token has no scope for costs only that source: a refused `workspaces` field used
 * to discard an intact personal project list along with it, which is the failure that
 * made this dashboard useless.
 *
 * Throws only when *every* source failed. A caller that gets projects back also gets
 * the failures, so it can say that part of the list is missing rather than implying the
 * list is complete.
 */
export async function listProjects(
  accessToken: string,
  signal?: AbortSignal,
): Promise<{
  viewer: Viewer;
  projects: RailwayProject[];
  failures: RailwayApiError[];
}> {
  /*
   * `toViewer` per source rather than one shared result type, because the two documents
   * select different halves of `me` and now say so: ProjectsPersonal carries `projects`,
   * ProjectsWorkspace carries `workspaces`, and neither generated type has the other's
   * field. `ViewerNode` stays the merged shape the mappers read, and each source maps into
   * it — which is where the optionality on that type comes from and is now the only place
   * it is claimed.
   */
  const read = async <TResult extends { me: unknown }>(
    name: SourceResult["name"],
    query: TypedDocument<TResult, Record<string, never>>,
    operationName: string,
    toViewer: (me: NonNullable<Refusable<TResult>["me"]>) => ViewerNode,
  ): Promise<SourceResult> => {
    try {
      const { data, errors } = await gqlPartial(
        query,
        {},
        { accessToken, operationName, signal },
      );
      // `me` itself refused means nothing usable came back, however the transport went.
      if (!data?.me) return { name, viewer: null, error: errors[0] ?? null };
      return { name, viewer: toViewer(data.me), error: errors[0] ?? null };
    } catch (error) {
      if (error instanceof RailwayApiError) return { name, viewer: null, error };
      throw error;
    }
  };

  const sources = await Promise.all([
    read("personal", PROJECTS_PERSONAL_QUERY, "ProjectsPersonal", (me) => ({
      id: me.id,
      // Narrowed rather than spread through: `name` is nullable on the live schema, and
      // ViewerNode carries both of these as absent-or-present rather than nullable.
      ...(me.name ? { name: me.name } : {}),
      ...(me.email ? { email: me.email } : {}),
      projects: me.projects,
    })),
    read("workspace", PROJECTS_WORKSPACE_QUERY, "ProjectsWorkspace", (me) => ({
      id: me.id,
      workspaces: me.workspaces,
    })),
  ]);

  const answered = sources.filter((source) => source.viewer !== null);
  const failures = sources
    .map((source) => source.error)
    .filter((error): error is RailwayApiError => error !== null);

  /*
   * Per source, because the caller only ever surfaces `failures[0]` and never says which
   * read it came from. "The workspace source has been refused for a week and nobody
   * noticed because the personal one still answers" is exactly the shape of degradation
   * a merged list hides, and this is the only place that distinction still exists.
   */
  for (const source of sources) {
    if (!source.error) continue;
    log.warn("railway.projects.source_failed", {
      source: source.name,
      answered: source.viewer !== null,
      error: source.error,
    });
  }

  /*
   * Nothing answered at all. The first failure is thrown rather than a summary, because
   * it is the one carrying the classification and the refused path — which is what
   * turns this into "approve workspace access" instead of "something went wrong".
   */
  if (answered.length === 0) {
    throw (
      failures.find((error) => error.kind === "auth") ??
      failures[0] ??
      new RailwayApiError("Railway returned no project sources", {
        kind: "graphql",
        operation: "ProjectsPersonal",
      })
    );
  }

  /*
   * Identity comes from whichever source answered, preferring the personal one because
   * that is the document carrying `name` and `email`.
   *
   * `answered[0]` is narrowed rather than asserted. It cannot be undefined — the branch
   * above returns when the list is empty — but that was expressed only by the throw
   * four lines up, and noUncheckedIndexedAccess exists precisely so the type system
   * does not have to take that on trust. This was the one `!` in src/, doubled.
   */
  const personal = answered.find((s) => s.name === "personal")?.viewer;
  const workspace = answered.find((s) => s.name === "workspace")?.viewer;
  const identity = personal ?? workspace;
  if (!identity) {
    throw new RailwayApiError("Railway returned no viewer", {
      kind: "graphql",
      operation: "ProjectsPersonal",
    });
  }

  // De-duplication is toProjects' job, so it is fed one merged viewer rather than being
  // called per source and re-merged here.
  const merged: ViewerNode = {
    id: identity.id,
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    projects: personal?.projects ?? null,
    workspaces: workspace?.workspaces ?? null,
  };

  return {
    viewer: { id: merged.id, name: merged.name, email: merged.email },
    projects: toProjects(merged),
    failures,
  };
}

/**
 * Everything the dashboard needs for one project, in a single request.
 *
 * Services created outside this app come back too, marked `managed: false`. They are
 * shown for context — an accurate picture of the environment matters — but the UI and
 * the spin-down action both refuse to destroy them.
 */
export async function getProjectContainers(
  accessToken: string,
  projectId: string,
  environmentId: string,
  signal?: AbortSignal,
): Promise<{ project: RailwayProject; containers: Container[] }> {
  const data = await gql(
    PROJECT_QUERY,
    { id: projectId },
    { accessToken, operationName: "Project", signal },
  );

  return {
    project: toProject(data.project),
    containers: toContainers(nodes(data.project.services), environmentId),
  };
}

/**
 * What the containers in one environment are using, and what the workspace has spent.
 *
 * `gqlPartial` rather than `gql`, and unlike everywhere else in this file that is the whole
 * design rather than a detail. Both halves of this document are things a given token may not
 * be permitted to read — `metrics` needs the project scope, `customer` needs the workspace
 * one — and Railway refuses a field with HTTP 200, an `errors[]` entry and the field nulled.
 * `gql` throws on that and would discard the half that did arrive.
 *
 * So this never throws for a refusal: it returns `{}` and `null`, and the dashboard renders
 * exactly what it rendered before this feature existed. Transport, rate-limit and 5xx
 * failures still throw, because `execute` throws before this returns, and the loader's catch
 * is where that is spelled out.
 *
 * One request per environment, not one per row — see PROJECT_METRICS_QUERY on why the
 * grouping matters to ADR-10's budget.
 */
export async function getProjectMetrics(
  accessToken: string,
  projectId: string,
  environmentId: string,
  signal?: AbortSignal,
): Promise<{
  metrics: Record<string, ContainerMetrics>;
  spend: WorkspaceSpend | null;
}> {
  const { data, errors } = await gqlPartial(
    PROJECT_METRICS_QUERY,
    {
      projectId,
      environmentId,
      measurements: ["CPU_USAGE", "MEMORY_USAGE_GB"],
      startDate: new Date(Date.now() - METRICS.WINDOW_MS).toISOString(),
      sampleRateSeconds: METRICS.SAMPLE_RATE_SECONDS,
      averagingWindowSeconds: METRICS.AVERAGING_WINDOW_SECONDS,
    },
    { accessToken, operationName: "ProjectMetrics", signal },
  );

  for (const error of errors) {
    /*
     * Debug, not warn, and the level is the decision here rather than an oversight.
     *
     * This read happens on every dashboard render. A token that will never hold
     * `workspace:viewer` would write a warn per render, forever, for a readout the UI
     * already has a designed answer for — which is precisely how a log store teaches people
     * to ignore warns. Same reasoning getDeploymentFailure states one function down.
     */
    log.debug("railway.metrics.refused", {
      project_id: projectId,
      error,
    });
  }

  return {
    metrics: toContainerMetrics(data?.metrics ?? []),
    spend: toWorkspaceSpend(data?.project?.workspace ?? null),
  };
}

/**
 * A new personal project, with whatever environment Railway created alongside it.
 *
 * Returns the mapped `RailwayProject` rather than the raw node so the caller can select it
 * immediately: the environments come back in this same response — see
 * PROJECT_CREATE_MUTATION — which is the difference between landing the user on their new
 * project and landing them on the empty state they just acted on.
 *
 * Nothing here is prefixed. `MANAGED_PREFIX` gates destroy, this app offers no way to
 * delete a project, and a marker that guards nothing would only put `spun-` on a name the
 * user typed and then reads back in Railway's own dashboard.
 */
export async function createProject(
  accessToken: string,
  name: string,
  signal?: AbortSignal,
): Promise<RailwayProject> {
  const data = await gql(
    PROJECT_CREATE_MUTATION,
    { input: { name } },
    { accessToken, operationName: "ProjectCreate", signal },
  );
  return toProject(data.projectCreate);
}

/**
 * A new, empty environment in an existing project.
 *
 * Empty is the contract, not an accident of the arguments — see
 * ENVIRONMENT_CREATE_MUTATION for why nothing is seeded or deployed into it.
 */
export async function createEnvironment(
  accessToken: string,
  projectId: string,
  name: string,
  signal?: AbortSignal,
): Promise<RailwayEnvironment> {
  const data = await gql(
    ENVIRONMENT_CREATE_MUTATION,
    { input: { projectId, name, skipInitialDeploys: true } },
    { accessToken, operationName: "EnvironmentCreate", signal },
  );
  return { id: data.environmentCreate.id, name: data.environmentCreate.name };
}

export async function createContainer(
  accessToken: string,
  params: {
    projectId: string;
    environmentId: string;
    /** Already prefixed by the caller via toManagedName(). */
    name: string;
    image: string;
    /**
     * Merged by the caller from the catalog's defaults and the rows the user submitted,
     * already validated. This layer sets what it is handed.
     */
    variables?: Record<string, string>;
  },
  signal?: AbortSignal,
): Promise<{
  serviceId: string;
  deploymentId: string | null;
  /**
   * What happened after `serviceCreate` returned.
   *
   * Both failure values mean the same thing to the caller — the service exists and is not
   * running — but they are different sentences to a user and different lines in the audit
   * log, so they are not collapsed into a boolean. Reaching any of the three means a
   * service was created; only a throw from this function means none was.
   */
  outcome: "deployed" | "variables_failed" | "deploy_failed";
}> {
  const created = await gql(
    SERVICE_CREATE_MUTATION,
    {
      input: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        name: params.name,
        source: { image: params.image },
      },
    },
    { accessToken, operationName: "ServiceCreate", signal },
  );

  const serviceId = created.serviceCreate.id;

  /*
   * Variables BEFORE the deploy, never after.
   *
   * A postgres container started without POSTGRES_PASSWORD exits on its first tick and
   * Railway restarts it forever — the user watches a crash loop and reasonably concludes
   * this app is broken. Setting them afterwards would need a redeploy and would show that
   * crash loop first.
   *
   * A failure here deliberately does NOT deploy, for the same reason the comment below
   * gives: an un-deployed service is visible, prefixed and destroyable from the
   * dashboard, which is strictly better than a running container in a restart loop
   * nobody can diagnose.
   */
  if (params.variables && Object.keys(params.variables).length > 0) {
    try {
      await gql(
        VARIABLE_COLLECTION_UPSERT_MUTATION,
        {
          input: {
            projectId: params.projectId,
            environmentId: params.environmentId,
            serviceId,
            variables: params.variables,
            replace: false,
            /*
             * Railway redeploys a service when its variables change. The explicit deploy
             * below is the one this app tracks — it returns the deployment id the row's
             * log stream keys on — so a second, variable-triggered deployment would leave
             * the user watching logs from a deployment that is not the current one.
             */
            skipDeploys: true,
          },
        },
        { accessToken, operationName: "VariableCollectionUpsert", signal },
      );
    } catch (error) {
      /*
       * A count, not names, and never values.
       *
       * Since T-487 this map is a merge of catalog defaults and rows the user typed, so
       * the names are no longer a closed set — the same reason the rejected deploymentId
       * is not logged. Nothing is lost: the caller's `container.created` line is written
       * on this path too, with `outcome: "variables_failed"`, and it names the closed
       * half.
       */
      log.warn("railway.variables_failed", {
        service_id: serviceId,
        variable_count: Object.keys(params.variables).length,
        error,
      });
      return { serviceId, deploymentId: null, outcome: "variables_failed" };
    }
  }

  /*
   * serviceCreate registers the service; the deploy is a separate step. If this second
   * call fails the service exists but is not running, which the dashboard shows as an
   * un-deployed container the user can destroy — better than silently orphaning it.
   *
   * Caught for the same reason the variables call above is: a throw from here would carry
   * no service id, so the caller could not tell "nothing was created" from "a billable
   * service was created and left un-deployed", and would log neither. The classification
   * this discards from the user's sentence — auth, rate limit, outage — is entirely
   * preserved in the record below, incident id included.
   */
  let deploymentId: string | null;
  try {
    deploymentId = await deployService(
      accessToken,
      { serviceId, environmentId: params.environmentId },
      signal,
    );
  } catch (error) {
    log.warn("railway.deploy_failed", { service_id: serviceId, error });
    return { serviceId, deploymentId: null, outcome: "deploy_failed" };
  }

  return { serviceId, deploymentId, outcome: "deployed" };
}

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
 *   - **The `RAILWAY_` namespace.** Railway injects its own block, and `validation.ts`
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
    { accessToken, operationName: "ServiceVariables", signal },
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
      { accessToken, operationName: "ServiceUpdate", signal },
    );
  }

  if (params.image !== undefined) {
    await gql(
      SERVICE_INSTANCE_UPDATE_MUTATION,
      { serviceId, environmentId, input: { source: { image: params.image } } },
      { accessToken, operationName: "ServiceInstanceUpdate", signal },
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
          { accessToken, operationName: "VariableDelete", signal },
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
          { accessToken, operationName: "VariableCollectionUpsert", signal },
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
    { accessToken, operationName: "ServiceInstanceDeployV2", signal },
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
  await gql(
    DEPLOYMENT_STOP_MUTATION,
    { id: deploymentId },
    { accessToken, operationName: "DeploymentStop", signal },
  );
}

/** Restart a deployment's container in place, keeping the deployment and its log stream. */
export async function restartDeployment(
  accessToken: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<void> {
  await gql(
    DEPLOYMENT_RESTART_MUTATION,
    { id: deploymentId },
    { accessToken, operationName: "DeploymentRestart", signal },
  );
}

export async function destroyContainer(
  accessToken: string,
  serviceId: string,
  signal?: AbortSignal,
): Promise<void> {
  await gql(
    SERVICE_DELETE_MUTATION,
    { id: serviceId },
    { accessToken, operationName: "ServiceDelete", signal },
  );
}

export async function getDeployment(
  accessToken: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<{ id: string; status: string | null; updatedAt: string | null } | null> {
  const data = await gql(
    DEPLOYMENT_QUERY,
    { id: deploymentId },
    { accessToken, operationName: "Deployment", signal },
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
    { accessToken, operationName: "DeploymentEvents", signal },
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
      { accessToken, operationName: "BuildLogs", signal },
    );
    // `?? []` although the schema says `[Log!]!`: a Railway that answered null here without
    // an errors[] entry would reach the log pane as a null array, and a backfill that
    // returns nothing is the designed empty state.
    return data.buildLogs ?? [];
  }

  const data = await gql(
    DEPLOYMENT_LOGS_QUERY,
    { deploymentId, limit },
    { accessToken, operationName: "DeploymentLogs", signal },
  );
  return data.deploymentLogs ?? [];
}
