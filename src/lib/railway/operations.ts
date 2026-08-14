/**
 * Every GraphQL document the app sends, in one file.
 *
 * Railway does not publish a schema artifact, so these are written against their docs
 * and the public GraphQL endpoint. `pnpm verify:schema` introspects the live API and
 * checks each root field below actually exists with the argument names used here —
 * run it before trusting any of this (see README, "Schema verification").
 */

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
export const PROJECTS_PERSONAL_QUERY = /* GraphQL */ `
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
export const PROJECTS_WORKSPACE_QUERY = /* GraphQL */ `
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

export const PROJECT_QUERY = /* GraphQL */ `
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
export const PROJECT_METRICS_QUERY = /* GraphQL */ `
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
 * other member is a decision the user has not been asked to make. Adding one means adding
 * it to REQUIRED_INPUT_TYPES below, because a member this app sends is a member whose
 * removal must fail verification.
 */
export const PROJECT_CREATE_MUTATION = /* GraphQL */ `
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
export const ENVIRONMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation EnvironmentCreate($input: EnvironmentCreateInput!) {
    environmentCreate(input: $input) {
      id
      name
    }
  }
`;

export const SERVICE_CREATE_MUTATION = /* GraphQL */ `
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
export const SERVICE_DEPLOY_MUTATION = /* GraphQL */ `
  mutation ServiceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
    serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

export const SERVICE_DELETE_MUTATION = /* GraphQL */ `
  mutation ServiceDelete($id: String!) {
    serviceDelete(id: $id)
  }
`;

export const DEPLOYMENT_QUERY = /* GraphQL */ `
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
export const DEPLOYMENT_EVENTS_QUERY = /* GraphQL */ `
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

export const DEPLOYMENT_LOGS_QUERY = /* GraphQL */ `
  query DeploymentLogs($deploymentId: String!, $limit: Int) {
    deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
      timestamp
      message
      severity
    }
  }
`;

export const BUILD_LOGS_QUERY = /* GraphQL */ `
  query BuildLogs($deploymentId: String!, $limit: Int) {
    buildLogs(deploymentId: $deploymentId, limit: $limit) {
      timestamp
      message
      severity
    }
  }
`;

/** Streamed over `wss://backboard.railway.com/graphql/v2` (graphql-transport-ws). */
export const DEPLOYMENT_LOGS_SUBSCRIPTION = /* GraphQL */ `
  subscription StreamDeploymentLogs($deploymentId: String!) {
    deploymentLogs(deploymentId: $deploymentId) {
      timestamp
      message
      severity
    }
  }
`;

export const BUILD_LOGS_SUBSCRIPTION = /* GraphQL */ `
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
export const VARIABLE_COLLECTION_UPSERT_MUTATION = /* GraphQL */ `
  mutation VariableCollectionUpsert($input: VariableCollectionUpsertInput!) {
    variableCollectionUpsert(input: $input)
  }
`;

/**
 * Root fields the app depends on, for `pnpm verify:schema`.
 * `args` lists argument names that must be present (not their types).
 */
export const REQUIRED_FIELDS: Array<{
  root: "Query" | "Mutation" | "Subscription";
  field: string;
  args: string[];
}> = [
  { root: "Query", field: "me", args: [] },
  { root: "Query", field: "project", args: ["id"] },
  { root: "Query", field: "deployment", args: ["id"] },
  { root: "Query", field: "deploymentLogs", args: ["deploymentId"] },
  { root: "Query", field: "buildLogs", args: ["deploymentId"] },
  { root: "Mutation", field: "serviceCreate", args: ["input"] },
  {
    root: "Mutation",
    field: "serviceInstanceDeployV2",
    args: ["serviceId", "environmentId"],
  },
  { root: "Mutation", field: "serviceDelete", args: ["id"] },
  /*
   * Required since the preset catalog started carrying environment. It was probed as
   * optional first — a mutation this app builds an input for by hand is not something to
   * assume — and confirmed against the live API on 2026-08-13, together with the shape in
   * REQUIRED_INPUT_TYPES below.
   *
   * Required rather than optional because a database preset without it does not degrade,
   * it crash-loops: `postgres` with no POSTGRES_PASSWORD exits on its first tick and
   * Railway restarts it forever.
   */
  { root: "Mutation", field: "variableCollectionUpsert", args: ["input"] },
  /*
   * The two create paths, confirmed against the live API on 2026-08-14 together with their
   * input shapes below. Both return an object rather than a Boolean —
   * `projectCreate: Project!` and `environmentCreate: Environment!` — which is what lets
   * the dashboard select what was just made instead of re-reading the list to find it.
   *
   * Required rather than optional because losing either does not degrade a feature, it
   * removes the app's answer to an empty account: the first-run path is a person with no
   * project, and the alternative to creating one here is sending them to railway.com and
   * hoping they come back.
   */
  { root: "Mutation", field: "projectCreate", args: ["input"] },
  { root: "Mutation", field: "environmentCreate", args: ["input"] },
  { root: "Subscription", field: "deploymentLogs", args: ["deploymentId"] },
  { root: "Subscription", field: "buildLogs", args: ["deploymentId"] },
];

/**
 * Capabilities Railway does not document in its public API guides. The verify script
 * reports whether each exists, and `note` says what the app can or cannot do without it —
 * previously the script printed one hardcoded sentence for all of them, which was already
 * wrong for `serviceInstanceUpdate`.
 */
export const OPTIONAL_FIELDS: Array<{
  root: "Query" | "Mutation";
  field: string;
  note: string;
}> = [
  /*
   * Where a failed deployment's reason lives, and the one entry here the app actually
   * sends. Optional rather than required because losing it costs no capability: a failed
   * row degrades to exactly what it showed before — the status, the fallback sentence, and
   * the link to Railway's own page.
   *
   * verify:schema reports the *root* field only. A withdrawn member of
   * DeploymentEventPayload is two types down and invisible to it; that arrives at runtime,
   * is swallowed by the same best-effort catch, and shows up as one debug record. Stated
   * in README's Limitations rather than papered over.
   */
  {
    root: "Query",
    field: "deploymentEvents",
    note: "a failed row shows the status and a link, with no reason",
  },
  /*
   * The usage readout, and with it the only cost signal the app has.
   *
   * Optional rather than required because a metrics read Railway refuses must degrade the
   * row, not blank the dashboard: the container list, its filters and every destructive
   * action are untouched by losing this, and the readout falls back to the same em dash it
   * shows for a container with no samples yet. Requiring it would exit `verify:schema`
   * non-zero — and therefore fail the schema CI job — over a capability the app already has
   * a clean answer for.
   *
   * The half this cannot see: `Customer.currentUsage`, which is three types below
   * `Query.project` and so invisible to a root-field check. That withdrawal arrives at
   * runtime, is absorbed by gqlPartial, and shows up as one debug record — the same gap
   * DeploymentEventPayload has, stated in README's Limitations rather than papered over.
   */
  {
    root: "Query",
    field: "metrics",
    note: "container rows show no CPU, memory or uptime, and the list shows no usage total",
  },
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
   * The per-key fallback. `variableCollectionUpsert` above is what the app actually sends
   * and is now required; this one is here so that if the collection form is ever withdrawn
   * the report names the replacement rather than leaving the reader to find it.
   */
  {
    root: "Mutation",
    field: "variableUpsert",
    note: "no per-key fallback if variableCollectionUpsert is withdrawn",
  },
];

/**
 * Input objects the app constructs by hand.
 *
 * `verify:schema` has always proved that root *fields* exist and has never once looked at
 * the shape of the input they take — which is exactly where `serviceCreate(input: {...})`
 * is an unchecked assumption. A renamed member there fails at runtime, per request, with
 * whatever wording Railway chooses.
 */
export const REQUIRED_INPUT_TYPES: Array<{ name: string; fields: string[] }> = [
  {
    name: "ServiceCreateInput",
    fields: ["projectId", "environmentId", "name", "source"],
  },
  /*
   * Every member listed here is one `createContainer` sends, `skipDeploys` included:
   * Railway redeploys a service when its variables change, and the app issues its own
   * deploy on the very next line. Losing that member would not fail loudly — it would
   * produce a second deployment the app never learns the id of, and the row would stream
   * logs for a deployment the user is not watching.
   */
  {
    name: "VariableCollectionUpsertInput",
    fields: [
      "projectId",
      "environmentId",
      "serviceId",
      "variables",
      "replace",
      "skipDeploys",
    ],
  },
  /*
   * `name` alone. Every other member of ProjectCreateInput is left out deliberately — see
   * PROJECT_CREATE_MUTATION — and listing one here that the app does not send would assert
   * a dependency it does not have.
   *
   * `name` is nullable on the live schema (`String`, not `String!`): Railway will name an
   * unnamed project itself. The app always sends one, so this entry is about the member
   * still existing, not about it being mandatory.
   */
  { name: "ProjectCreateInput", fields: ["name"] },
  /*
   * `skipInitialDeploys` is in this list for the same reason `skipDeploys` is in the one
   * above: its removal would not fail loudly, it would quietly start billing someone for a
   * copy of every service in the project.
   */
  {
    name: "EnvironmentCreateInput",
    fields: ["projectId", "name", "skipInitialDeploys"],
  },
];

/**
 * Enum members the app sends by name.
 *
 * The third axis of the same defect REQUIRED_INPUT_TYPES exists for. A root-field check
 * proves `Query.metrics` is still there; it says nothing about `CPU_USAGE` still being a
 * member of `MetricMeasurement`, and a withdrawn member is not a degraded readout — it is
 * GRAPHQL_VALIDATION_FAILED on every metrics request, because the whole document fails to
 * validate. `groupBy: [SERVICE_ID]` is written into the document itself and has exactly the
 * same exposure.
 *
 * Only members the app actually sends. `CPU_USAGE_2` and the limit measurements are real and
 * are not here, for the reason ProjectCreateInput's note gives: listing something the app
 * does not send asserts a dependency it does not have.
 */
export const REQUIRED_ENUM_MEMBERS: Array<{ name: string; members: string[] }> = [
  { name: "MetricMeasurement", members: ["CPU_USAGE", "MEMORY_USAGE_GB"] },
  { name: "MetricTag", members: ["SERVICE_ID"] },
];

/** Printed, never enforced: the shape is unknown until the probe has been run. */
export const PROBED_INPUT_TYPES: string[] = ["VariableUpsertInput"];
