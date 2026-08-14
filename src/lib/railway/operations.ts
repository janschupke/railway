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
];

/** Printed, never enforced: the shape is unknown until the probe has been run. */
export const PROBED_INPUT_TYPES: string[] = ["VariableUpsertInput"];
