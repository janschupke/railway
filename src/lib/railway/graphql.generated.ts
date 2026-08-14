/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> =
  T | { [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never };
export type DeploymentEventStep =
  | "BUILD_IMAGE"
  | "CONFIGURE_NETWORK"
  | "CREATE_CONTAINER"
  | "DRAIN_INSTANCES"
  | "HEALTHCHECK"
  | "MIGRATE_VOLUMES"
  | "PRE_DEPLOY_COMMAND"
  | "PUBLISH_IMAGE"
  | "SNAPSHOT_CODE"
  | "WAIT_FOR_DEPENDENCIES";

export type DeploymentStatus =
  | "BUILDING"
  | "CRASHED"
  | "DEPLOYING"
  | "FAILED"
  | "INITIALIZING"
  | "NEEDS_APPROVAL"
  | "QUEUED"
  | "REMOVED"
  | "REMOVING"
  | "SKIPPED"
  | "SLEEPING"
  | "SUCCESS"
  | "WAITING";

export type EnvironmentCreateInput = {
  /** If true, the changes will be applied in the background and the mutation will return immediately. If false, the mutation will wait for the changes to be applied before returning. */
  applyChangesInBackground?: boolean | null | undefined;
  ephemeral?: boolean | null | undefined;
  name: string;
  projectId: string;
  /** When committing the changes immediately, skip any initial deployments. */
  skipInitialDeploys?: boolean | null | undefined;
  /** Create the environment with all of the services, volumes, configuration, and variables from this source environment. */
  sourceEnvironmentId?: string | null | undefined;
  /** Stage the initial changes for the environment. If false (default), the changes will be committed immediately. */
  stageInitialChanges?: boolean | null | undefined;
};

/** A thing that can be measured on Railway. */
export type MetricMeasurement =
  | "BACKUP_USAGE_GB"
  | "CPU_LIMIT"
  | "CPU_USAGE"
  | "CPU_USAGE_2"
  | "DISK_USAGE_GB"
  | "EPHEMERAL_DISK_USAGE_GB"
  | "MEASUREMENT_UNSPECIFIED"
  | "MEMORY_LIMIT_GB"
  | "MEMORY_USAGE_GB"
  | "NETWORK_RX_GB"
  | "NETWORK_TX_GB"
  | "UNRECOGNIZED";

export type ProjectCreateInput = {
  defaultEnvironmentName?: string | null | undefined;
  description?: string | null | undefined;
  isMonorepo?: boolean | null | undefined;
  isPublic?: boolean | null | undefined;
  name?: string | null | undefined;
  prDeploys?: boolean | null | undefined;
  repo?: ProjectCreateRepo | null | undefined;
  runtime?: PublicRuntime | null | undefined;
  workspaceId?: string | null | undefined;
};

export type ProjectCreateRepo = {
  branch: string;
  fullRepoName: string;
};

export type PublicRuntime = "LEGACY" | "UNSPECIFIED" | "V2";

/** Private Docker registry credentials. Only available for Pro plan deployments. */
export type RegistryCredentialsInput = {
  password: string;
  username: string;
};

export type ServiceCreateInput = {
  branch?: string | null | undefined;
  /** Environment ID. If the specified environment is a fork, the service will only be created in it. Otherwise it will created in all environments that are not forks of other environments */
  environmentId?: string | null | undefined;
  icon?: string | null | undefined;
  name?: string | null | undefined;
  projectId: string;
  registryCredentials?: RegistryCredentialsInput | null | undefined;
  source?: ServiceSourceInput | null | undefined;
  /** Template ID. Required when templateServiceId is provided. */
  templateId?: string | null | undefined;
  /** Template service ID within the template's serializedConfig. Required when templateId is provided. */
  templateServiceId?: string | null | undefined;
  variables?: Record<string, string> | null | undefined;
};

export type ServiceSourceInput = {
  image?: string | null | undefined;
  repo?: string | null | undefined;
};

export type VariableCollectionUpsertInput = {
  environmentId: string;
  projectId: string;
  /** When set to true, removes all existing variables before upserting the new collection. */
  replace?: boolean | null | undefined;
  serviceId?: string | null | undefined;
  /** Skip deploys for affected services */
  skipDeploys?: boolean | null | undefined;
  variables: Record<string, string>;
};

export type ProjectFieldsFragment = {
  id: string;
  name: string;
  environments: { edges: Array<{ node: { id: string; name: string } }> };
};

export type ProjectsPersonalQueryVariables = Exact<{ [key: string]: never }>;

export type ProjectsPersonalQuery = {
  me: {
    id: string;
    name: string | null;
    email: string;
    projects: {
      edges: Array<{
        node: {
          id: string;
          name: string;
          environments: { edges: Array<{ node: { id: string; name: string } }> };
        };
      }>;
    };
  };
};

export type ProjectsWorkspaceQueryVariables = Exact<{ [key: string]: never }>;

export type ProjectsWorkspaceQuery = {
  me: {
    id: string;
    workspaces: Array<{
      id: string;
      name: string;
      projects: {
        edges: Array<{
          node: {
            id: string;
            name: string;
            environments: { edges: Array<{ node: { id: string; name: string } }> };
          };
        }>;
      };
    }>;
  };
};

export type ProjectQueryVariables = Exact<{
  id: string;
}>;

export type ProjectQuery = {
  project: {
    id: string;
    name: string;
    environments: { edges: Array<{ node: { id: string; name: string } }> };
    services: {
      edges: Array<{
        node: {
          id: string;
          name: string;
          createdAt: string;
          serviceInstances: {
            edges: Array<{
              node: {
                id: string;
                environmentId: string;
                source: { image: string | null; repo: string | null } | null;
                latestDeployment: {
                  id: string;
                  status: DeploymentStatus;
                  createdAt: string;
                  updatedAt: string;
                } | null;
              };
            }>;
          };
        };
      }>;
    };
  };
};

export type ProjectMetricsQueryVariables = Exact<{
  projectId: string;
  environmentId: string;
  measurements: Array<MetricMeasurement> | MetricMeasurement;
  startDate: string;
  sampleRateSeconds?: number | null | undefined;
  averagingWindowSeconds?: number | null | undefined;
}>;

export type ProjectMetricsQuery = {
  metrics: Array<{
    measurement: MetricMeasurement;
    tags: { serviceId: string | null };
    values: Array<{ ts: number; value: number }>;
  }>;
  project: {
    id: string;
    workspace: {
      id: string;
      name: string;
      customer: { currentUsage: number; billingPeriod: { start: string; end: string } };
    } | null;
  };
};

export type ProjectCreateMutationVariables = Exact<{
  input: ProjectCreateInput;
}>;

export type ProjectCreateMutation = {
  projectCreate: {
    id: string;
    name: string;
    environments: { edges: Array<{ node: { id: string; name: string } }> };
  };
};

export type EnvironmentCreateMutationVariables = Exact<{
  input: EnvironmentCreateInput;
}>;

export type EnvironmentCreateMutation = {
  environmentCreate: { id: string; name: string };
};

export type ServiceCreateMutationVariables = Exact<{
  input: ServiceCreateInput;
}>;

export type ServiceCreateMutation = { serviceCreate: { id: string; name: string } };

export type ServiceInstanceDeployV2MutationVariables = Exact<{
  serviceId: string;
  environmentId: string;
}>;

export type ServiceInstanceDeployV2Mutation = { serviceInstanceDeployV2: string };

export type ServiceDeleteMutationVariables = Exact<{
  id: string;
}>;

export type ServiceDeleteMutation = { serviceDelete: boolean };

export type DeploymentQueryVariables = Exact<{
  id: string;
}>;

export type DeploymentQuery = {
  deployment: {
    id: string;
    status: DeploymentStatus;
    createdAt: string;
    updatedAt: string;
  };
};

export type DeploymentEventsQueryVariables = Exact<{
  id: string;
  last?: number | null | undefined;
}>;

export type DeploymentEventsQuery = {
  deploymentEvents: {
    edges: Array<{
      node: {
        step: DeploymentEventStep;
        payload: {
          error: string | null;
          reason: string | null;
          detail: string | null;
          skipped: boolean | null;
        } | null;
      };
    }>;
  };
};

export type DeploymentLogsQueryVariables = Exact<{
  deploymentId: string;
  limit?: number | null | undefined;
}>;

export type DeploymentLogsQuery = {
  deploymentLogs: Array<{
    timestamp: string;
    message: string;
    severity: string | null;
  }>;
};

export type BuildLogsQueryVariables = Exact<{
  deploymentId: string;
  limit?: number | null | undefined;
}>;

export type BuildLogsQuery = {
  buildLogs: Array<{ timestamp: string; message: string; severity: string | null }>;
};

export type StreamDeploymentLogsSubscriptionVariables = Exact<{
  deploymentId: string;
}>;

export type StreamDeploymentLogsSubscription = {
  deploymentLogs: Array<{
    timestamp: string;
    message: string;
    severity: string | null;
  }>;
};

export type StreamBuildLogsSubscriptionVariables = Exact<{
  deploymentId: string;
}>;

export type StreamBuildLogsSubscription = {
  buildLogs: Array<{ timestamp: string; message: string; severity: string | null }>;
};

export type VariableCollectionUpsertMutationVariables = Exact<{
  input: VariableCollectionUpsertInput;
}>;

export type VariableCollectionUpsertMutation = { variableCollectionUpsert: boolean };
