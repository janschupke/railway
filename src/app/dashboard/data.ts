import "server-only";

import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/auth/server";
import { getProjectContainers, listProjects } from "@/lib/railway/api";
import { RailwayApiError } from "@/lib/railway/errors";
import type { MessageKey } from "@/lib/messages";
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

type Translator = Awaited<ReturnType<typeof getTranslations>>;

/**
 * A Railway failure explains itself where it can; anything else falls back to the
 * message for the read that failed. Both come from the catalog.
 */
function describe(t: Translator, error: unknown, fallback: MessageKey): string {
  const descriptor =
    error instanceof RailwayApiError
      ? error.describe()
      : { key: fallback, values: undefined };
  return t(descriptor.key as Parameters<Translator>[0], descriptor.values as never);
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

  const t = await getTranslations();

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
    return { ...base, error: describe(t, error, "errors.projectsFailed") };
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
      error: describe(t, error, "errors.containersFailed"),
    };
  }
}
