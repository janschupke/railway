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

export function execute(
  operationName: string,
  variables: Record<string, unknown>,
  store: Store,
): Result {
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
