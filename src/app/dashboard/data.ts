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

export type DashboardShell = {
  user: { name?: string; email?: string };
  projects: RailwayProject[];
  project: RailwayProject | null;
  environment: RailwayEnvironment | null;
  /** Set when the project list failed; the header and shell still render. */
  error: string | null;
};

export type ContainerListData = {
  containers: Container[];
  /** Set when this environment's containers failed; the section still renders. */
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
 * Everything the page shell needs: identity, the project list, and the resolved
 * selection.
 *
 * Deliberately does NOT read containers. That is a second Railway round trip, and
 * holding the shell for it is what made switching projects freeze the whole page —
 * the container list is loaded behind its own Suspense boundary instead.
 *
 * Failures degrade rather than throw: a Railway outage should render the shell with an
 * explanation, not an error boundary that loses the user's project selection.
 *
 * Returns null when there is no session, which the page turns into a redirect — the
 * redirect belongs to routing, not to data loading.
 */
export async function loadDashboardShell(params: {
  projectId?: string;
  environmentId?: string;
}): Promise<DashboardShell | null> {
  const session = await getSession();
  if (!session) return null;

  const t = await getTranslations();

  const base: DashboardShell = {
    user: { name: session.user.name, email: session.user.email },
    projects: [],
    project: null,
    environment: null,
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

  return { ...base, projects, project, environment };
}

/**
 * The container list for one environment.
 *
 * Reads the session itself rather than taking a token: `getSession` is a cookie read
 * plus a JWE open with no network call, and cookies are request-scoped, so calling it a
 * second time costs nothing and keeps this independently callable and testable.
 */
export async function loadContainers(
  projectId: string,
  environmentId: string,
): Promise<ContainerListData> {
  const session = await getSession();
  // The shell already redirected an anonymous request; this is a guard, not a path.
  if (!session) return { containers: [], error: null };

  try {
    const { containers } = await getProjectContainers(
      session.accessToken,
      projectId,
      environmentId,
    );
    return { containers, error: null };
  } catch (error) {
    const t = await getTranslations();
    return { containers: [], error: describe(t, error, "errors.containersFailed") };
  }
}
