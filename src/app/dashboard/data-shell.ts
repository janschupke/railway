/**
 * Identity, the project list, and the project and environment this request resolved to.
 *
 * Everything the page needs before it can decide whether there is a container list to ask
 * for. Degrades rather than throwing: a source the token cannot read costs that source and
 * says so through `partial`, because a dashboard that shows nothing is the failure this
 * whole path was built to stop.
 */

import "server-only";

import { cache } from "react";
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
 *
 * Memoized for the render, for the reason data-containers.ts gives: three pages call this
 * now — the container list, the spin-up form and the billing readout — and each of them is
 * one `listProjects` if the memo misses.
 *
 * **The arguments are positional, and that is the whole reason the memo works.** `cache`
 * compares arguments by identity, so the `{ projectId, environmentId }` object this used to
 * take missed on every call: a fresh literal per call site is never the same object as the
 * last one. It would have shipped as a wrapper that looks memoized and is not, which is
 * invisible in review. For the same reason a caller must pass `undefined` straight through
 * rather than coercing an absent param to `""` — that is a different key and a second
 * Railway round trip.
 */
export const loadDashboardShell = cache(
  async (projectId?: string, environmentId?: string): Promise<DashboardShell | null> =>
    /*
     * A Server Component render cannot be wrapped from outside, so the scope is entered at
     * the loaders instead. That is the right granularity anyway: they are the only RSC code
     * that logs, and loadContainers runs in its own Suspense subtree where `headers()`
     * still resolves this same request.
     *
     * Inside the memo rather than around it, so the second caller reads a settled promise
     * instead of re-entering the scope for a request that is not being made.
     */
    withRequestScope("/dashboard", { trustInboundId: true }, () =>
      shell(projectId, environmentId),
    ),
);

async function shell(
  projectId?: string,
  environmentId?: string,
): Promise<DashboardShell | null> {
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

  const requested = projectId
    ? (projects.find((p) => p.id === projectId) ?? null)
    : null;
  const project = requested ?? projects[0] ?? null;
  const environment =
    project?.environments.find((e) => e.id === environmentId) ??
    project?.environments[0] ??
    null;

  if (Boolean(projectId) && !requested && projects.length > 0) {
    // debug: a genuine anomaly — the URL names a project this session can no longer see —
    // but it is per-render and the UI already says so.
    log.debug("dashboard.selection_dropped", {
      requested_project_id: projectId,
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
    droppedSelection: Boolean(projectId) && !requested && projects.length > 0,
  };
}
