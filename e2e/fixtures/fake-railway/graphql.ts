import type { Store } from "./store";

/**
 * The subset of Railway's GraphQL API this app uses, dispatched by operation name
 * rather than executed against a schema.
 *
 * A fixture does not need an execution engine, and hand-dispatching keeps the shapes
 * visible: if the app's real query drifts from what Railway returns, `pnpm
 * verify:schema` is what catches it, not this.
 */

type Result = {
  data?: unknown;
  errors?: Array<{ message: string; path?: string[]; extensions?: unknown }>;
};

const edges = <T>(items: T[]) => ({ edges: items.map((node) => ({ node })) });

/**
 * Railway's refusal, in the shape it actually sends.
 *
 * HTTP 200, the words "Not Authorized", and INTERNAL_SERVER_ERROR — not one of the
 * codes the spec suggests. The fixture reproduces that verbatim because a fixture that
 * answers UNAUTHENTICATED would have let the misclassification this app shipped with
 * pass every test it had.
 */
const notAuthorized = (path: string[]): Result => ({
  data: null,
  errors: [
    { message: "Not Authorized", path, extensions: { code: "INTERNAL_SERVER_ERROR" } },
  ],
});

/**
 * Operations this fixture has answered, by name.
 *
 * The only way a spec can prove something about *server* traffic. The watch endpoint
 * holds its SSE response open, so the browser issues one request and then nothing —
 * a spec watching page.on("request") sees the connection but never the polling behind
 * it, and could only ever assert on elapsed time instead.
 */
export const operationCounts: Record<string, number> = {};

export function resetOperationCounts(): void {
  for (const key of Object.keys(operationCounts)) delete operationCounts[key];
}

export function execute(
  operationName: string,
  variables: Record<string, unknown>,
  store: Store,
): Result {
  operationCounts[operationName] = (operationCounts[operationName] ?? 0) + 1;

  switch (operationName) {
    /*
     * The project list is three independent documents. Each answers for itself, which
     * is the whole point: one source being refused must cost only that source.
     */
    case "ProjectsPersonal": {
      if (store.faults.rejectPersonal) return notAuthorized(["me", "projects"]);

      const source = store.faults.projectsSource;
      const projects =
        source === "personal" || source === "both"
          ? store.projects.map((p) => ({
              id: p.id,
              name: p.name,
              environments: edges(p.environments),
            }))
          : [];

      // Identity rides on this document; there is no separate Viewer query.
      return {
        data: {
          me: {
            id: "user_e2e",
            name: "Ada Lovelace",
            email: "ada@example.com",
            projects: edges(projects),
          },
        },
      };
    }

    case "ProjectsWorkspace": {
      // What a token without `workspace:viewer` gets. It used to take the whole
      // dashboard down with it.
      if (store.faults.rejectWorkspaces) return notAuthorized(["me", "workspaces"]);

      const source = store.faults.projectsSource;
      const projects =
        source === "workspace" || source === "both"
          ? store.projects.map((p) => ({
              id: p.id,
              name: p.name,
              environments: edges(p.environments),
            }))
          : [];

      return {
        data: {
          me: {
            id: "user_e2e",
            workspaces: [{ id: "ws_e2e", name: "Acme", projects: edges(projects) }],
          },
        },
      };
    }

    case "Project": {
      const project = store.projects.find((p) => p.id === variables.id);
      if (!project) return { errors: [{ message: "Project not found" }] };

      return {
        data: {
          project: {
            id: project.id,
            name: project.name,
            environments: edges(project.environments),
            services: edges(
              store.servicesIn(project.id).map((service) => {
                const deployment = service.deploymentId
                  ? store.deployments.get(service.deploymentId)
                  : undefined;
                return {
                  id: service.id,
                  name: service.name,
                  createdAt: service.createdAt,
                  serviceInstances: edges([
                    {
                      id: `si_${service.id}`,
                      environmentId: service.environmentId,
                      source: { image: service.image, repo: service.repo },
                      domains: {
                        serviceDomains: service.domains.map((domain) => ({ domain })),
                      },
                      latestDeployment: deployment
                        ? {
                            id: deployment.id,
                            status: deployment.status,
                            // The DEPLOYMENT's own creation, not the service's. Uptime is
                            // measured from this, and service.createdAt is epoch zero here.
                            createdAt: deployment.createdAt,
                            updatedAt: deployment.updatedAt,
                          }
                        : null,
                    },
                  ]),
                };
              }),
            ),
          },
        },
      };
    }

    /*
     * Two root fields in one response, each refusable on its own — which is the behaviour
     * gqlPartial exists for, and the only part of it a spec can observe from outside.
     */
    case "ProjectMetrics": {
      const projectId = variables.projectId as string;
      const environmentId = variables.environmentId as string;
      const project = store.projects.find((p) => p.id === projectId);

      const errors: NonNullable<Result["errors"]> = [];

      let metrics: unknown[] | null = [];
      if (store.faults.metricsFail) {
        metrics = null;
        errors.push({
          message: "Not Authorized",
          path: ["metrics"],
          extensions: { code: "INTERNAL_SERVER_ERROR" },
        });
      } else {
        const now = Math.floor(Date.now() / 1000);
        metrics = store
          .servicesIn(projectId)
          .filter((service) => service.environmentId === environmentId)
          .flatMap((service) => {
            const usage = store.metricsFor(service);
            // No series at all for a service that is not running. An empty result is
            // ordinary, and it must not become a zero anywhere on the way through.
            if (!usage) return [];
            return [
              {
                measurement: "CPU_USAGE",
                tags: { serviceId: service.id },
                values: [{ ts: now, value: usage.cpu }],
              },
              {
                measurement: "MEMORY_USAGE_GB",
                tags: { serviceId: service.id },
                values: [{ ts: now, value: usage.memory }],
              },
            ];
          });
      }

      let workspace: unknown = null;
      if (store.faults.workspaceFail) {
        errors.push({
          message: "Not Authorized",
          path: ["project", "workspace"],
          extensions: { code: "INTERNAL_SERVER_ERROR" },
        });
      } else if (!store.faults.noWorkspace) {
        workspace = { id: "ws_e2e", name: "Acme", customer: store.customer() };
      }

      return {
        data: { metrics, project: project ? { id: project.id, workspace } : null },
        ...(errors.length ? { errors } : {}),
      };
    }

    case "ProjectCreate": {
      const input = variables.input as { name: string };
      const project = store.addProject(input.name);
      // The full ProjectFields selection: the app reads the default environment straight
      // out of this response rather than re-reading the project list to find it.
      return {
        data: {
          projectCreate: {
            id: project.id,
            name: project.name,
            environments: edges(project.environments),
          },
        },
      };
    }

    case "EnvironmentCreate": {
      const input = variables.input as { projectId: string; name: string };
      const environment = store.addEnvironment(input.projectId, input.name);
      if (!environment) return { errors: [{ message: "Project not found" }] };
      return { data: { environmentCreate: environment } };
    }

    case "ServiceCreate": {
      const input = variables.input as {
        projectId: string;
        environmentId: string;
        name: string;
        source: { image: string };
      };
      const service = store.addService({
        name: input.name,
        projectId: input.projectId,
        environmentId: input.environmentId,
        image: input.source.image,
      });
      return { data: { serviceCreate: { id: service.id, name: service.name } } };
    }

    case "ServiceUpdate": {
      const id = variables.id as string;
      const input = variables.input as { name: string };
      const service = store.services.get(id);
      if (!service) return { errors: [{ message: "Service not found" }] };
      service.name = input.name;
      return { data: { serviceUpdate: { id: service.id, name: service.name } } };
    }

    case "ServiceInstanceUpdate": {
      const serviceId = variables.serviceId as string;
      const input = variables.input as { source?: { image?: string } };
      const service = store.services.get(serviceId);
      if (!service) return { errors: [{ message: "Service not found" }] };
      /*
       * Only what was sent. The app sends `source` alone, and a fake that overwrote the
       * rest would hide the very thing SERVICE_INSTANCE_UPDATE_MUTATION is careful about —
       * that every other member of the input is left alone.
       */
      if (input.source?.image) service.image = input.source.image;
      /*
       * Deliberately does NOT start a deployment, even though the real Railway may.
       * The app issues its own deploy on the next line and keys the row on the id that
       * returns; a fixture that also deployed here would make the double-deploy invisible
       * rather than reproducing it.
       */
      return { data: { serviceInstanceUpdate: true } };
    }

    case "ServiceVariables": {
      if (store.faults.variablesFail) {
        return { errors: [{ message: "Not Authorized" }] };
      }
      const serviceId = variables.serviceId as string;
      const service = store.services.get(serviceId);
      if (!service) return { errors: [{ message: "Service not found" }] };
      /*
       * Two aliased reads of the same field, which is what the app sends. `service` answers
       * what the service resolves — its own variables merged over the environment's shared
       * ones, which is Railway's documented behaviour and the reason the app subtracts.
       * `shared` answers the environment's set alone.
       */
      return {
        data: {
          service: { ...store.sharedVariables, ...service.variables },
          shared: { ...store.sharedVariables },
        },
      };
    }

    case "VariableDelete": {
      if (store.faults.variablesFail) {
        return { errors: [{ message: "Not Authorized" }] };
      }
      const input = variables.input as { serviceId: string; name: string };
      const service = store.services.get(input.serviceId);
      if (!service) return { errors: [{ message: "Service not found" }] };
      delete service.variables[input.name];
      return { data: { variableDelete: true } };
    }

    case "VariableCollectionUpsert": {
      if (store.faults.variablesFail) {
        // Railway's real refusal shape: HTTP 200 with a field-level error.
        return { errors: [{ message: "Not Authorized" }] };
      }
      const input = variables.input as {
        serviceId: string;
        variables: Record<string, string>;
      };
      const service = store.services.get(input.serviceId);
      if (!service) return { errors: [{ message: "Service not found" }] };
      service.variables = { ...service.variables, ...input.variables };
      return { data: { variableCollectionUpsert: 1 } };
    }

    case "ServiceInstanceDeployV2": {
      const serviceId = variables.serviceId as string;
      if (!store.services.has(serviceId)) {
        return { errors: [{ message: "Service not found" }] };
      }
      return { data: { serviceInstanceDeployV2: store.addDeployment(serviceId).id } };
    }

    case "ServiceDomainCreate": {
      const input = variables.input as {
        serviceId: string;
        environmentId: string;
        targetPort?: number;
      };
      if (store.faults.domainFails) {
        return {
          errors: [
            {
              message: "Not Authorized",
              path: ["serviceDomainCreate"],
              extensions: { code: "INTERNAL_SERVER_ERROR" },
            },
          ],
        };
      }
      const domain = store.addServiceDomain(input.serviceId, input.environmentId);
      if (!domain) return { errors: [{ message: "Service not found" }] };
      return {
        data: {
          serviceDomainCreate: {
            id: `dom_${input.serviceId}`,
            domain,
            // Echoed rather than defaulted: the app omits this member entirely when it has
            // no port, and null here is what says so.
            targetPort: input.targetPort ?? null,
          },
        },
      };
    }

    case "DeploymentStop": {
      const deployment = store.stopDeployment(variables.id as string);
      if (!deployment) return { errors: [{ message: "Deployment not found" }] };
      return { data: { deploymentStop: true } };
    }

    case "DeploymentRestart": {
      const deployment = store.restartDeployment(variables.id as string);
      if (!deployment) return { errors: [{ message: "Deployment not found" }] };
      return { data: { deploymentRestart: true } };
    }

    case "ServiceDelete": {
      const id = variables.id as string;
      const service = store.services.get(id);
      if (!service) return { errors: [{ message: "Service not found" }] };
      store.services.delete(id);
      if (service.deploymentId) store.deployments.delete(service.deploymentId);
      /*
       * Detached, NOT deleted. Railway does not cascade — probed, not assumed — and that
       * single fact is why destroy has a checkbox at all. A fixture that removed the volume
       * here would make the "keep the data" branch untestable and would agree with an app
       * that quietly orphaned storage.
       */
      store.orphanVolumesOf(id);
      return { data: { serviceDelete: true } };
    }

    case "VolumeCreate": {
      if (store.faults.volumeCreateFail) {
        // Railway's real refusal shape: HTTP 200 with a field-level error.
        return { errors: [{ message: "Not Authorized" }] };
      }
      const input = variables.input as {
        projectId: string;
        environmentId: string;
        serviceId: string;
        mountPath: string;
      };
      if (!store.services.has(input.serviceId)) {
        return { errors: [{ message: "Service not found" }] };
      }
      const volume = store.addVolume(input);
      return { data: { volumeCreate: { id: volume.id, name: volume.name } } };
    }

    case "VolumeDelete": {
      const volumeId = variables.volumeId as string;
      if (!store.volumes.has(volumeId)) {
        return { errors: [{ message: "Volume not found" }] };
      }
      store.volumes.delete(volumeId);
      return { data: { volumeDelete: true } };
    }

    case "EnvironmentVolumes": {
      // What an unscoped token gets. The app has to degrade to keeping the data, not to
      // pretending there is none to keep.
      if (store.faults.volumesFail) return notAuthorized(["environment"]);

      const environmentId = variables.id as string;
      return {
        data: {
          environment: {
            id: environmentId,
            volumeInstances: edges(
              store.volumesIn(environmentId).map((volume) => ({
                id: volume.instanceId,
                volumeId: volume.id,
                serviceId: volume.serviceId,
                mountPath: volume.mountPath,
                sizeMB: volume.sizeMB,
                currentSizeMB: volume.currentSizeMB,
              })),
            ),
          },
        },
      };
    }

    case "Deployment": {
      const deployment = store.deployments.get(variables.id as string);
      return {
        data: {
          deployment: deployment
            ? {
                id: deployment.id,
                status: deployment.status,
                createdAt: new Date(0).toISOString(),
                updatedAt: deployment.updatedAt,
              }
            : null,
        },
      };
    }

    case "DeploymentEvents": {
      // Railway's real refusal shape, so the app meets the one it will actually see.
      if (store.faults.deploymentEventsFail) return notAuthorized(["deploymentEvents"]);

      const deployment = store.deployments.get(variables.id as string);
      // `last` slices the tail, which is the Relay semantics the app's picker depends on:
      // it walks the connection backwards to find the newest event carrying text.
      const last = Number(variables.last ?? 10);
      return {
        data: { deploymentEvents: edges((deployment?.events ?? []).slice(-last)) },
      };
    }

    case "DeploymentLogs":
    case "BuildLogs": {
      const deployment = store.deployments.get(variables.deploymentId as string);
      const isBuild = operationName === "BuildLogs";
      const field = isBuild ? "buildLogs" : "deploymentLogs";
      // Per phase, because the two are not the same output — see Deployment.logs.
      return {
        data: { [field]: deployment?.logs[isBuild ? "build" : "deploy"] ?? [] },
      };
    }

    default:
      return { errors: [{ message: `Unhandled operation: ${operationName}` }] };
  }
}

/** Reads the operation name out of a document, since there is no parser here. */
export function operationNameOf(query: string, provided?: string): string {
  if (provided) return provided;
  const match = /(?:query|mutation|subscription)\s+(\w+)/.exec(query);
  return match?.[1] ?? "";
}
