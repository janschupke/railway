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
  errors?: Array<{ message: string; extensions?: unknown }>;
};

const edges = <T>(items: T[]) => ({ edges: items.map((node) => ({ node })) });

export function execute(
  operationName: string,
  variables: Record<string, unknown>,
  store: Store,
): Result {
  switch (operationName) {
    case "Projects":
      return {
        data: {
          me: {
            id: "user_e2e",
            name: "Ada Lovelace",
            email: "ada@example.com",
            projects: edges(
              store.projects.map((p) => ({
                id: p.id,
                name: p.name,
                environments: edges(p.environments),
              })),
            ),
          },
        },
      };

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
                      latestDeployment: deployment
                        ? {
                            id: deployment.id,
                            status: deployment.status,
                            createdAt: service.createdAt,
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

    case "ServiceInstanceDeployV2": {
      const serviceId = variables.serviceId as string;
      if (!store.services.has(serviceId)) {
        return { errors: [{ message: "Service not found" }] };
      }
      return { data: { serviceInstanceDeployV2: store.addDeployment(serviceId).id } };
    }

    case "ServiceDelete": {
      const id = variables.id as string;
      const service = store.services.get(id);
      if (!service) return { errors: [{ message: "Service not found" }] };
      store.services.delete(id);
      if (service.deploymentId) store.deployments.delete(service.deploymentId);
      return { data: { serviceDelete: true } };
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

    case "DeploymentLogs":
    case "BuildLogs": {
      const deployment = store.deployments.get(variables.deploymentId as string);
      const field = operationName === "BuildLogs" ? "buildLogs" : "deploymentLogs";
      return { data: { [field]: deployment?.logs ?? [] } };
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
