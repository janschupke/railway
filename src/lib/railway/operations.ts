/**
 * Every GraphQL document the app sends, in one file.
 *
 * Railway does not publish a schema artifact, so `pnpm schema:pull` dumps one from live
 * introspection into ./schema.graphql, `pnpm codegen` generates the result and variable
 * types below from it, and every document here is validated against it — nested fields,
 * argument names, enum members and all. A renamed field fails `pnpm codegen`, and a
 * mismatched result type fails `pnpm typecheck` at the call site.
 *
 * `pnpm verify:schema` is what says whether that committed schema still matches the live
 * API. It validates these same documents against Railway's current schema and diffs the
 * surface they reach — see README, "Schema verification".
 *
 * The type annotations are the load-bearing part of each export. `TypedDocument<Result,
 * Variables>` is what `gql`/`gqlPartial` read the shapes from, so a document and its types
 * cannot drift apart and the variables are checked against the document that consumes them.
 */

import type {
  BuildLogsQuery,
  BuildLogsQueryVariables,
  DeploymentEventsQuery,
  DeploymentEventsQueryVariables,
  DeploymentLogsQuery,
  DeploymentLogsQueryVariables,
  DeploymentQuery,
  DeploymentQueryVariables,
  EnvironmentCreateMutation,
  EnvironmentCreateMutationVariables,
  ProjectCreateMutation,
  ProjectCreateMutationVariables,
  ProjectMetricsQuery,
  ProjectMetricsQueryVariables,
  ProjectQuery,
  ProjectQueryVariables,
  ProjectsPersonalQuery,
  ProjectsPersonalQueryVariables,
  ProjectsWorkspaceQuery,
  ProjectsWorkspaceQueryVariables,
  ServiceCreateMutation,
  ServiceCreateMutationVariables,
  ServiceDeleteMutation,
  ServiceDeleteMutationVariables,
  ServiceInstanceDeployV2Mutation,
  ServiceInstanceDeployV2MutationVariables,
  StreamBuildLogsSubscription,
  StreamBuildLogsSubscriptionVariables,
  StreamDeploymentLogsSubscription,
  StreamDeploymentLogsSubscriptionVariables,
  VariableCollectionUpsertMutation,
  VariableCollectionUpsertMutationVariables,
} from "./graphql.generated";
import type { TypedDocument } from "./typed-document";

/** A fragment, not an operation: interpolated into the three documents that select it. */
const PROJECT_FIELDS = /* GraphQL */ `
  fragment ProjectFields on Project {
    id
    name
    environments {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

/*
 * The project list is read as three independent documents rather than one.
 *
 * They used to be a single query, and that is what broke the dashboard outright: an
 * OAuth token holding `project:admin` but no workspace scope makes Railway refuse the
 * `workspaces` field, and a refusal anywhere in the document was treated as a refusal
 * of the whole thing — so a personal project list that had arrived perfectly intact was
 * thrown away, on every load, forever.
 *
 * Separate documents mean one source failing costs exactly that source. `listProjects`
 * merges whatever answered and only fails when nothing did.
 *
 * `pnpm probe:projects` prints what each source actually returns for a real session;
 * run that before editing these, rather than reasoning about which one "should" work.
 */

/**
 * The personal project source, which also carries identity.
 *
 * `name` and `email` used to come from a third document of their own, issued in
 * parallel purely to read `me { id name email }` — fields this query was already one
 * selection away from. Railway's rate limit is the binding constraint on this app
 * (1000/hour on Hobby), so a whole request per dashboard load for three scalars is the
 * expensive kind of tidy. A token refused these two fields degrades to a nameless
 * header rather than an empty dashboard: they are optional on ViewerNode, and gqlPartial
 * keeps whatever `me` did return.
 */
export const PROJECTS_PERSONAL_QUERY: TypedDocument<
  ProjectsPersonalQuery,
  ProjectsPersonalQueryVariables
> = /* GraphQL */ `
  ${PROJECT_FIELDS}
  query ProjectsPersonal {
    me {
      id
      name
      email
      projects {
        edges {
          node {
            ...ProjectFields
          }
        }
      }
    }
  }
`;

/**
 * Projects owned by a workspace the user belongs to.
 *
 * Selects `workspace.projects` rather than `workspace.team.projects`: both survive
 * validation, but only the former appears in the live introspected field list for
 * `Workspace`, so the latter is the one liable to disappear without notice. Requires a
 * `workspace:*` scope at consent — see SCOPES in lib/auth/oidc.ts.
 */
export const PROJECTS_WORKSPACE_QUERY: TypedDocument<
  ProjectsWorkspaceQuery,
  ProjectsWorkspaceQueryVariables
> = /* GraphQL */ `
  ${PROJECT_FIELDS}
  query ProjectsWorkspace {
    me {
      id
      workspaces {
        id
        name
        projects {
          edges {
            node {
              ...ProjectFields
            }
          }
        }
      }
    }
  }
`;

export const PROJECT_QUERY: TypedDocument<ProjectQuery, ProjectQueryVariables> =
  /* GraphQL */ `
    query Project($id: String!) {
      project(id: $id) {
        id
        name
        environments {
          edges {
            node {
              id
              name
            }
          }
        }
        services {
          edges {
            node {
              id
              name
              createdAt
              serviceInstances {
                edges {
                  node {
                    id
                    environmentId
                    source {
                      image
                      repo
                    }
                    latestDeployment {
                      id
                      status
                      createdAt
                      updatedAt
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

/**
 * What the containers in one environment are using, and what the workspace has spent.
 *
 * Two root fields in one document because they are both root fields, both optional, and
 * both wanted by the same render — and because `gqlPartial` means a refusal of either costs
 * only that half.
 *
 * NOT folded into PROJECT_QUERY, which is the important part. That document is polled every
 * WATCH_POLL_MS for the life of every open watcher, so a refused or withdrawn `metrics`
 * field there would be a rejection on *every* tick — which the watch loop classifies as
 * transient, backs off from, and rides out. The dashboard would stop noticing that
 * containers had changed because a readout was refused. It would also force
 * `getProjectContainers` onto `gqlPartial`, softening the app's most important read for a
 * field nobody asked to be forgiving. Same trade DEPLOYMENT_EVENTS_QUERY makes, for the
 * same reason.
 *
 * `groupBy: [SERVICE_ID]` rather than a `serviceId` argument: one request covers every
 * service in the environment, whatever the list length. A per-row query would be exactly the
 * third polling source ADR-10's budget cannot absorb.
 *
 * `tags { serviceId }` and nothing else. `deploymentId`, `environmentId`, `region`,
 * `volumeId` and four more all exist and are all left out — each is one more field whose
 * withdrawal takes the whole document with it, and none of them changes what the row says.
 *
 * `endDate` is deliberately not sent. Absent means "up to now"; sending a client-computed
 * end is one clock-skew bug away from an empty series, and there is nothing to gain.
 *
 * `project.workspace` is NULLABLE on the live schema — a personal project belongs to no
 * workspace — so null here is an ordinary state and not a failure. `customer.currentUsage`
 * is the only monetary figure anywhere in Railway's schema, and it covers the whole
 * workspace; `estimatedUsage` returns GB and vCPU rather than money, which is why it is not
 * selected here. Whatever renders this has to say which of those it is showing.
 */
export const PROJECT_METRICS_QUERY: TypedDocument<
  ProjectMetricsQuery,
  ProjectMetricsQueryVariables
> = /* GraphQL */ `
  query ProjectMetrics(
    $projectId: String!
    $environmentId: String!
    $measurements: [MetricMeasurement!]!
    $startDate: DateTime!
    $sampleRateSeconds: Int
    $averagingWindowSeconds: Int
  ) {
    metrics(
      projectId: $projectId
      environmentId: $environmentId
      measurements: $measurements
      startDate: $startDate
      groupBy: [SERVICE_ID]
      sampleRateSeconds: $sampleRateSeconds
      averagingWindowSeconds: $averagingWindowSeconds
    ) {
      measurement
      tags {
        serviceId
      }
      values {
        ts
        value
      }
    }
    project(id: $projectId) {
      id
      workspace {
        id
        name
        customer {
          currentUsage
          billingPeriod {
            start
            end
          }
        }
      }
    }
  }
`;

/**
 * A new project on the signed-in user's personal account.
 *
 * Selects `...ProjectFields` rather than a bare `id`, and that is what the create flow is
 * built on: `projectCreate` returns `Project!` — the same type the list query reads — so
 * the default environment Railway makes alongside the project arrives in this response.
 * Without it the client would have a project id and no environment id, and would have to
 * re-read the whole project list before it could select what it had just created.
 *
 * `ProjectCreateInput` also carries `workspaceId`, `defaultEnvironmentName`, `description`,
 * `isPublic`, `prDeploys`, `repo`, `runtime` and `isMonorepo`. The app sends `name` and
 * nothing else: an omitted `workspaceId` is what makes the project personal, and every
 * other member is a decision the user has not been asked to make. Sending one is all it
 * takes for its removal to fail verification now: the member is in
 * `ProjectCreateMutationVariables`, so `pnpm typecheck` rejects the object the day
 * `pnpm schema:pull` stops finding it, and there is no list to remember to update.
 */
export const PROJECT_CREATE_MUTATION: TypedDocument<
  ProjectCreateMutation,
  ProjectCreateMutationVariables
> = /* GraphQL */ `
  ${PROJECT_FIELDS}
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      ...ProjectFields
    }
  }
`;

/**
 * A new environment inside an existing project.
 *
 * `skipInitialDeploys: true` is load-bearing rather than tidy. Railway seeds a new
 * environment from an existing one and deploys what it copies, so a person clicking "New
 * environment" would be billed for a duplicate of every service in the project without
 * having asked for one. This app creates infrastructure only when someone names it, and
 * `sourceEnvironmentId` is deliberately not sent for the same reason.
 *
 * `ephemeral`, `stageInitialChanges` and `applyChangesInBackground` are the remaining
 * members and are all left out — see the note on ProjectCreateInput above.
 */
export const ENVIRONMENT_CREATE_MUTATION: TypedDocument<
  EnvironmentCreateMutation,
  EnvironmentCreateMutationVariables
> = /* GraphQL */ `
  mutation EnvironmentCreate($input: EnvironmentCreateInput!) {
    environmentCreate(input: $input) {
      id
      name
    }
  }
`;

export const SERVICE_CREATE_MUTATION: TypedDocument<
  ServiceCreateMutation,
  ServiceCreateMutationVariables
> = /* GraphQL */ `
  mutation ServiceCreate($input: ServiceCreateInput!) {
    serviceCreate(input: $input) {
      id
      name
    }
  }
`;

/**
 * `serviceInstanceDeployV2` returns the new deployment id, which is what the log
 * subscription keys on. The older `serviceInstanceDeploy` returns a Boolean and would
 * force a follow-up query to find the deployment.
 */
export const SERVICE_DEPLOY_MUTATION: TypedDocument<
  ServiceInstanceDeployV2Mutation,
  ServiceInstanceDeployV2MutationVariables
> = /* GraphQL */ `
  mutation ServiceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
    serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

export const SERVICE_DELETE_MUTATION: TypedDocument<
  ServiceDeleteMutation,
  ServiceDeleteMutationVariables
> = /* GraphQL */ `
  mutation ServiceDelete($id: String!) {
    serviceDelete(id: $id)
  }
`;

export const DEPLOYMENT_QUERY: TypedDocument<
  DeploymentQuery,
  DeploymentQueryVariables
> = /* GraphQL */ `
  query Deployment($id: String!) {
    deployment(id: $id) {
      id
      status
      createdAt
      updatedAt
    }
  }
`;

/**
 * Why a deployment failed. A second document on purpose, not four more fields above.
 *
 * The `Deployment` type carries no reason at all — `diagnosis` and `meta` are opaque
 * SCALARs with no documented shape, which is not something to select and render — so the
 * only place the reason exists is this event feed.
 *
 * It stays out of DEPLOYMENT_QUERY because that document is polled every
 * STREAM.STATUS_POLL_MS for the life of every open stream. A field withdrawn or refused
 * there is a rejection on *every* poll, which pollStatus classifies as transient, logs
 * once at warn and then at debug, and rides out for the full STREAM.MAX_DURATION_MS. Here
 * the same withdrawal costs one best-effort read per failed deployment and the row falls
 * back to the sentence it already had.
 *
 * The selection is deliberately minimal for the same reason: `id`, `createdAt`,
 * `completedAt`, `attempt` and `maxAttempts` all exist and are all left out, because each
 * is one more field whose withdrawal would take the whole document with it and none of
 * them changes what the row says. `skipped` earns its place by changing which event is
 * chosen; `step` earns its place by being a bounded enum this app can translate, and the
 * only useful thing left when all three text members come back null.
 */
export const DEPLOYMENT_EVENTS_QUERY: TypedDocument<
  DeploymentEventsQuery,
  DeploymentEventsQueryVariables
> = /* GraphQL */ `
  query DeploymentEvents($id: String!, $last: Int) {
    deploymentEvents(id: $id, last: $last) {
      edges {
        node {
          step
          payload {
            error
            reason
            detail
            skipped
          }
        }
      }
    }
  }
`;

export const DEPLOYMENT_LOGS_QUERY: TypedDocument<
  DeploymentLogsQuery,
  DeploymentLogsQueryVariables
> = /* GraphQL */ `
  query DeploymentLogs($deploymentId: String!, $limit: Int) {
    deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
      timestamp
      message
      severity
    }
  }
`;

export const BUILD_LOGS_QUERY: TypedDocument<BuildLogsQuery, BuildLogsQueryVariables> =
  /* GraphQL */ `
    query BuildLogs($deploymentId: String!, $limit: Int) {
      buildLogs(deploymentId: $deploymentId, limit: $limit) {
        timestamp
        message
        severity
      }
    }
  `;

/** Streamed over `wss://backboard.railway.com/graphql/v2` (graphql-transport-ws). */
export const DEPLOYMENT_LOGS_SUBSCRIPTION: TypedDocument<
  StreamDeploymentLogsSubscription,
  StreamDeploymentLogsSubscriptionVariables
> = /* GraphQL */ `
  subscription StreamDeploymentLogs($deploymentId: String!) {
    deploymentLogs(deploymentId: $deploymentId) {
      timestamp
      message
      severity
    }
  }
`;

export const BUILD_LOGS_SUBSCRIPTION: TypedDocument<
  StreamBuildLogsSubscription,
  StreamBuildLogsSubscriptionVariables
> = /* GraphQL */ `
  subscription StreamBuildLogs($deploymentId: String!) {
    buildLogs(deploymentId: $deploymentId) {
      timestamp
      message
      severity
    }
  }
`;

/**
 * Environment for a service, set in one call.
 *
 * `replace: false` — the service was created moments ago and has nothing to replace, and
 * a mutation that can silently wipe variables is the wrong default to have lying around.
 */
export const VARIABLE_COLLECTION_UPSERT_MUTATION: TypedDocument<
  VariableCollectionUpsertMutation,
  VariableCollectionUpsertMutationVariables
> = /* GraphQL */ `
  mutation VariableCollectionUpsert($input: VariableCollectionUpsertInput!) {
    variableCollectionUpsert(input: $input)
  }
`;

/**
 * Documents whose withdrawal degrades a readout rather than breaking the app.
 *
 * Everything else here is a dependency, and `verify:schema` derives that from the documents
 * themselves: it validates each one against Railway's live schema, so a field, argument,
 * enum member or input member this app sends and Railway no longer offers exits non-zero.
 * There is no list of required fields to keep up to date any more, which is the point —
 * the old one could only ever name *root* fields, and named them by hand.
 *
 * These two are the exception, and each is exactly the trade its own document explains.
 * `Query.metrics` and `Query.deploymentEvents` are read through `gqlPartial`, on paths that
 * already render a designed answer when Railway says no, so failing the schema CI job over
 * one would be failing a build over a capability the app has a clean answer for. A
 * validation error inside these two documents is reported and does not fail the run.
 *
 * The exemption is per document rather than per field, which is wider than it needs to be
 * and costs nothing: `Query.project` is selected by ProjectMetrics as well, and it is a
 * hard dependency — but PROJECT_QUERY selects it too and is not exempt, so its withdrawal
 * still fails the run there.
 */
export const DEGRADING_OPERATIONS: Array<{ operationName: string; note: string }> = [
  /*
   * Where a failed deployment's reason lives. Losing it costs no capability: a failed row
   * degrades to exactly what it showed before — the status, the fallback sentence, and the
   * link to Railway's own page.
   */
  {
    operationName: "DeploymentEvents",
    note: "a failed row shows the status and a link, with no reason",
  },
  /*
   * The usage readout, and with it the only cost signal the app has.
   *
   * A metrics read Railway refuses must degrade the row, not blank the dashboard: the
   * container list, its filters and every destructive action are untouched by losing this,
   * and the readout falls back to the same em dash it shows for a container with no samples
   * yet.
   */
  {
    operationName: "ProjectMetrics",
    note: "container rows show no CPU, memory or uptime, and the list shows no usage total",
  },
];

/**
 * Capabilities Railway does not document in its public API guides, and this app does not
 * use. The verify script reports whether each exists, and `note` says what the app can or
 * cannot do without it — previously the script printed one hardcoded sentence for all of
 * them, which was already wrong for `serviceInstanceUpdate`.
 *
 * These cannot be derived from the documents for the same reason the entries above can: no
 * document mentions them. They are a wishlist against the live schema, which is why
 * `variableUpsert` is here while the collection form the app actually sends is not.
 */
export const OPTIONAL_FIELDS: Array<{
  root: "Query" | "Mutation";
  field: string;
  note: string;
}> = [
  {
    root: "Mutation",
    field: "deploymentStop",
    note: "spin-down stays destroy-only",
  },
  {
    root: "Mutation",
    field: "deploymentRemove",
    note: "spin-down stays destroy-only",
  },
  {
    root: "Mutation",
    field: "serviceInstanceUpdate",
    note: "a service cannot be edited in place",
  },
  /*
   * The per-key fallback. `variableCollectionUpsert` is what the app actually sends, and a
   * document that sends it is what makes it a dependency; this entry is here so that if the
   * collection form is ever withdrawn the report names the replacement rather than leaving
   * the reader to find it.
   */
  {
    root: "Mutation",
    field: "variableUpsert",
    note: "no per-key fallback if variableCollectionUpsert is withdrawn",
  },
];

/** Printed, never enforced: the shape is unknown until the probe has been run. */
export const PROBED_INPUT_TYPES: string[] = ["VariableUpsertInput"];
