/**
 * Every GraphQL document the app sends, in one file.
 *
 * Railway does not publish a schema artifact, so these are written against their docs
 * and the public GraphQL endpoint. `pnpm verify:schema` introspects the live API and
 * checks each root field below actually exists with the argument names used here —
 * run it before trusting any of this (see README, "Schema verification").
 */

export const PROJECTS_QUERY = /* GraphQL */ `
  query Projects {
    me {
      id
      name
      email
      projects {
        edges {
          node {
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
  { root: "Subscription", field: "deploymentLogs", args: ["deploymentId"] },
  { root: "Subscription", field: "buildLogs", args: ["deploymentId"] },
];

/**
 * Mutations that would let the app stop a container without destroying it. Neither is
 * documented in Railway's public API guides; the verify script reports whether they
 * exist so "spin down" can offer stop-vs-destroy rather than destroy only.
 */
export const OPTIONAL_FIELDS: Array<{ root: "Mutation"; field: string }> = [
  { root: "Mutation", field: "deploymentStop" },
  { root: "Mutation", field: "deploymentRemove" },
  { root: "Mutation", field: "serviceInstanceUpdate" },
];
