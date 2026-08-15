/**
 * Identity, the project list, and the project and environment this request resolved to.
 *
 * Everything the page needs before it can decide whether there is a container list to ask
 * for. Degrades rather than throwing: a source the token cannot read costs that source and
 * says so through `partial`, because a dashboard that shows nothing is the failure this
 * whole path was built to stop.
 */

import "server-only";

import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/auth/server";
import { listProjects } from "@/lib/railway/projects";
import { RailwayApiError } from "@/lib/railway/errors";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import type { RailwayProject, RailwayWorkspace } from "@/lib/railway/types";
import type { DashboardShell } from "./dashboard-types";
import { describe, missingScopes } from "./describe-error";

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
  /*
   * A Server Component render cannot be wrapped from outside, so the scope is entered at
   * the loaders instead. That is the right granularity anyway: they are the only RSC code
   * that logs, and loadContainers runs in its own Suspense subtree where `headers()`
   * still resolves this same request.
   */
  return withRequestScope("/dashboard", { trustInboundId: true }, () => shell(params));
}

async function shell(params: {
  projectId?: string;
  environmentId?: string;
}): Promise<DashboardShell | null> {
  const session = await getSession();
  if (!session) return null;

  const t = await getTranslations();

  const base: DashboardShell = {
    user: { name: session.user.name, email: session.user.email },
    projects: [],
    workspaces: [],
    project: null,
    environment: null,
    error: null,
    partialError: null,
    errorKind: null,
    missingScopes: missingScopes(session.scope),
    droppedSelection: false,
  };

  let projects: RailwayProject[];
  let workspaces: RailwayWorkspace[];
  let failures: RailwayApiError[];
  try {
    ({ projects, workspaces, failures } = await listProjects(session.accessToken));
  } catch (error) {
    return {
      ...base,
      error: describe(t, error, "errors.projectsFailed"),
      errorKind: error instanceof RailwayApiError ? error.kind : null,
    };
  }

  const requested = params.projectId
    ? (projects.find((p) => p.id === params.projectId) ?? null)
    : null;
  const project = requested ?? projects[0] ?? null;
  const environment =
    project?.environments.find((e) => e.id === params.environmentId) ??
    project?.environments[0] ??
    null;

  if (Boolean(params.projectId) && !requested && projects.length > 0) {
    // debug: a genuine anomaly — the URL names a project this session can no longer see —
    // but it is per-render and the UI already says so.
    log.debug("dashboard.selection_dropped", {
      requested_project_id: params.projectId,
    });
  }

  return {
    ...base,
    projects,
    workspaces,
    project,
    environment,
    // Reported, not thrown: these projects are real and usable, and the sentence says
    // which part of the list is missing rather than replacing the whole page.
    partialError: failures[0]
      ? describe(t, failures[0], "errors.projectsFailed")
      : null,
    // Only a *replaced* selection is worth reporting. An unknown environment inside the
    // right project resolves to that project's own default, which is not a substitution.
    droppedSelection: Boolean(params.projectId) && !requested && projects.length > 0,
  };
}
