/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> =
  T | { [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never };
export type Builder = "HEROKU" | "NIXPACKS" | "PAKETO" | "RAILPACK";

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

export type DeploymentListInput = {
  environmentId?: string | null | undefined;
  includeDeleted?: boolean | null | undefined;
  projectId?: string | null | undefined;
  serviceId?: string | null | undefined;
  status?: DeploymentStatusInput | null | undefined;
};

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

export type DeploymentStatusInput = {
  in?: Array<DeploymentStatus> | null | undefined;
  notIn?: Array<DeploymentStatus> | null | undefined;
};

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

export type RestartPolicyType = "ALWAYS" | "NEVER" | "ON_FAILURE";

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

export type ServiceDomainCreateInput = {
  environmentId: string;
  serviceId: string;
  targetPort?: number | null | undefined;
};

export type ServiceInstanceLimitsUpdateInput = {
  environmentId: string;
  /** Amount of memory in GB to allocate to the service instance */
  memoryGB?: number | null | undefined;
  serviceId: string;
  /** Number of vCPUs to allocate to the service instance */
  vCPUs?: number | null | undefined;
};

export type ServiceInstanceUpdateInput = {
  buildCommand?: string | null | undefined;
  builder?: Builder | null | undefined;
  cronSchedule?: string | null | undefined;
  dockerfilePath?: string | null | undefined;
  drainingSeconds?: number | null | undefined;
  healthcheckPath?: string | null | undefined;
  healthcheckTimeout?: number | null | undefined;
  ipv6EgressEnabled?: boolean | null | undefined;
  multiRegionConfig?: unknown;
  nixpacksPlan?: unknown;
  numReplicas?: number | null | undefined;
  overlapSeconds?: number | null | undefined;
  preDeployCommand?: Array<string> | null | undefined;
  railwayConfigFile?: string | null | undefined;
  region?: string | null | undefined;
  registryCredentials?: RegistryCredentialsInput | null | undefined;
  restartPolicyMaxRetries?: number | null | undefined;
  restartPolicyType?: RestartPolicyType | null | undefined;
  rootDirectory?: string | null | undefined;
  sleepApplication?: boolean | null | undefined;
  source?: ServiceSourceInput | null | undefined;
  startCommand?: string | null | undefined;
  watchPatterns?: Array<string> | null | undefined;
};

export type ServiceSourceInput = {
  image?: string | null | undefined;
  repo?: string | null | undefined;
};

export type ServiceUpdateInput = {
  icon?: string | null | undefined;
  name?: string | null | undefined;
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

export type VariableDeleteInput = {
  environmentId: string;
  name: string;
  projectId: string;
  serviceId?: string | null | undefined;
};

export type VolumeCreateInput = {
  /** The environment to deploy the volume instances into. If `null`, the volume will not be deployed to any environment. `undefined` will deploy to all environments. */
  environmentId?: string | null | undefined;
  /** The path in the container to mount the volume to */
  mountPath: string;
  /** The project to create the volume in */
  projectId: string;
  /** The region to create the volume instances in. If not provided, the default region will be used. */
  region?: string | null | undefined;
  /** The service to attach the volume to. If not provided, the volume will be disconnected. */
  serviceId?: string | null | undefined;
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
                domains: { serviceDomains: Array<{ domain: string }> };
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

export type RegionsQueryVariables = Exact<{
  projectId?: string | null | undefined;
}>;

export type RegionsQuery = {
  regions: Array<{
    id: string | null;
    name: string;
    location: string;
    country: string;
    deploymentConstraints: { deprecationInfo: { isDeprecated: boolean } | null } | null;
  }>;
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

export type ServiceUpdateMutationVariables = Exact<{
  id: string;
  input: ServiceUpdateInput;
}>;

export type ServiceUpdateMutation = { serviceUpdate: { id: string; name: string } };

export type ServiceInstanceUpdateMutationVariables = Exact<{
  serviceId: string;
  environmentId: string;
  input: ServiceInstanceUpdateInput;
}>;

export type ServiceInstanceUpdateMutation = { serviceInstanceUpdate: boolean };

export type ServiceInstanceQueryVariables = Exact<{
  serviceId: string;
  environmentId: string;
}>;

export type ServiceInstanceQuery = {
  serviceInstance: {
    id: string;
    numReplicas: number | null;
    restartPolicyType: RestartPolicyType;
    restartPolicyMaxRetries: number;
    startCommand: string | null;
  };
};

export type ServiceInstanceLimitsUpdateMutationVariables = Exact<{
  input: ServiceInstanceLimitsUpdateInput;
}>;

export type ServiceInstanceLimitsUpdateMutation = {
  serviceInstanceLimitsUpdate: boolean;
};

export type ServiceInstanceDeployV2MutationVariables = Exact<{
  serviceId: string;
  environmentId: string;
}>;

export type ServiceInstanceDeployV2Mutation = { serviceInstanceDeployV2: string };

export type ServiceDeleteMutationVariables = Exact<{
  id: string;
}>;

export type ServiceDeleteMutation = { serviceDelete: boolean };

export type ServiceDomainCreateMutationVariables = Exact<{
  input: ServiceDomainCreateInput;
}>;

export type ServiceDomainCreateMutation = {
  serviceDomainCreate: { id: string; domain: string; targetPort: number | null };
};

export type VolumeCreateMutationVariables = Exact<{
  input: VolumeCreateInput;
}>;

export type VolumeCreateMutation = { volumeCreate: { id: string; name: string } };

export type VolumeDeleteMutationVariables = Exact<{
  volumeId: string;
}>;

export type VolumeDeleteMutation = { volumeDelete: boolean };

export type EnvironmentVolumesQueryVariables = Exact<{
  id: string;
}>;

export type EnvironmentVolumesQuery = {
  environment: {
    id: string;
    volumeInstances: {
      edges: Array<{
        node: {
          id: string;
          volumeId: string;
          serviceId: string | null;
          mountPath: string;
          sizeMB: number;
          currentSizeMB: number;
        };
      }>;
    };
  };
};

export type DeploymentStopMutationVariables = Exact<{
  id: string;
}>;

export type DeploymentStopMutation = { deploymentStop: boolean };

export type DeploymentRestartMutationVariables = Exact<{
  id: string;
}>;

export type DeploymentRestartMutation = { deploymentRestart: boolean };

export type DeploymentRollbackMutationVariables = Exact<{
  id: string;
}>;

export type DeploymentRollbackMutation = { deploymentRollback: boolean };

export type DeploymentsQueryVariables = Exact<{
  input: DeploymentListInput;
  last?: number | null | undefined;
}>;

export type DeploymentsQuery = {
  deployments: {
    edges: Array<{
      node: {
        id: string;
        status: DeploymentStatus;
        createdAt: string;
        canRollback: boolean;
      };
    }>;
  };
};

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

export type ServiceVariablesQueryVariables = Exact<{
  projectId: string;
  environmentId: string;
  serviceId: string;
}>;

export type ServiceVariablesQuery = {
  service: Record<string, string>;
  shared: Record<string, string>;
};

export type VariableDeleteMutationVariables = Exact<{
  input: VariableDeleteInput;
}>;

export type VariableDeleteMutation = { variableDelete: boolean };
