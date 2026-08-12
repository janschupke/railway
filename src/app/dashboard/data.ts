import "server-only";

import { getSession } from "@/lib/auth/server";
import { getProjectContainers, listProjects } from "@/lib/railway/api";
import { RailwayApiError } from "@/lib/railway/errors";
import type {
  Container,
  RailwayEnvironment,
  RailwayProject,
} from "@/lib/railway/types";

export type DashboardData = {
  user: { name?: string; email?: string };
  projects: RailwayProject[];
  project: RailwayProject | null;
  environment: RailwayEnvironment | null;
  containers: Container[];
  /** Set when a load partially failed; the page still renders what it has. */
  error: string | null;
};

function describe(error: unknown, fallback: string): string {
  return error instanceof RailwayApiError ? error.userMessage() : fallback;
}

/**
 * All dashboard reads in one place.
 *
 * Failures degrade rather than throw: a Railway outage should render the shell with an
 * explanation, not an error boundary that loses the user's project selection. The page
 * stays a pure composition of this result.
 *
 * Returns null when there is no session, which the page turns into a redirect — the
 * redirect belongs to routing, not to data loading.
 */
export async function loadDashboard(params: {
  projectId?: string;
  environmentId?: string;
}): Promise<DashboardData | null> {
  const session = await getSession();
  if (!session) return null;

  const base: DashboardData = {
    user: { name: session.user.name, email: session.user.email },
    projects: [],
    project: null,
    environment: null,
    containers: [],
    error: null,
  };

  let projects: RailwayProject[];
  try {
    ({ projects } = await listProjects(session.accessToken));
  } catch (error) {
    return { ...base, error: describe(error, "Could not load your Railway projects.") };
  }

  const project =
    projects.find((p) => p.id === params.projectId) ?? projects[0] ?? null;
  const environment =
    project?.environments.find((e) => e.id === params.environmentId) ??
    project?.environments[0] ??
    null;

  if (!project || !environment) {
    return { ...base, projects, project, environment };
  }

  try {
    const { containers } = await getProjectContainers(
      session.accessToken,
      project.id,
      environment.id,
    );
    return { ...base, projects, project, environment, containers };
  } catch (error) {
    return {
      ...base,
      projects,
      project,
      environment,
      error: describe(error, "Could not load containers for this environment."),
    };
  }
}
