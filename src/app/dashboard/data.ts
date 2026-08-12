import "server-only";

import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/auth/server";
import { getProjectContainers, listProjects } from "@/lib/railway/api";
import { RailwayApiError, type RailwayErrorKind } from "@/lib/railway/errors";
import { reportError } from "@/lib/report-error";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
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
  /**
   * Set when some project sources answered and others did not.
   *
   * A list that is real but incomplete must say so. Silently showing the projects that
   * happened to load, with no sign that a whole workspace was refused, is how someone
   * concludes their projects are gone.
   */
  partialError: string | null;
  /**
   * What kind of failure, so the page can offer the action that matches it.
   *
   * A rate limit wants a retry; a rejected credential wants re-consent. Offering both
   * every time trains the user to click the one that never helps.
   */
  errorKind: RailwayErrorKind | null;
  /**
   * Scopes the app asked for at consent and did not get.
   *
   * The empty dashboard has two very different causes — nothing to show, or no
   * permission to see it — and they need opposite advice. Only a missing scope makes
   * re-authorizing the useful action; without this the UI can only guess, and guessing
   * is what sent users round the consent screen with nothing changing.
   */
  missingScopes: string[];
  /**
   * True when the URL named a project that is no longer in the list.
   *
   * Falling silently back to the first project shows someone else's containers under a
   * link they believe points somewhere specific.
   */
  droppedSelection: boolean;
};

export type ContainerListData = {
  containers: Container[];
  /** Set when this environment's containers failed; the section still renders. */
  error: string | null;
};

type Translator = Awaited<ReturnType<typeof getTranslations>>;

/**
 * Scopes requested at consent that Railway did not grant.
 *
 * `openid`/`email`/`profile` are omitted deliberately: losing them changes what the
 * header shows, not whether the app works, and naming them here would push the user
 * toward a re-consent that fixes nothing.
 */
const SCOPES_THAT_MATTER = [
  "project:admin",
  "workspace:viewer",
  "offline_access",
] as const;

function missingScopes(granted: string): string[] {
  const held = new Set(granted.split(/\s+/).filter(Boolean));
  return SCOPES_THAT_MATTER.filter((scope) => !held.has(scope));
}

/**
 * A Railway failure explains itself where it can; anything else falls back to the
 * message for the read that failed. Both come from the catalog, and reportError has
 * already written the upstream text to the log against the id the sentence carries.
 */
function describe(t: Translator, error: unknown, fallback: MessageKey): string {
  const descriptor = reportError("dashboard", error, fallback);
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
    project: null,
    environment: null,
    error: null,
    partialError: null,
    errorKind: null,
    missingScopes: missingScopes(session.scope),
    droppedSelection: false,
  };

  let projects: RailwayProject[];
  let failures: RailwayApiError[];
  try {
    ({ projects, failures } = await listProjects(session.accessToken));
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
  return withRequestScope("/dashboard", { trustInboundId: true }, () =>
    containerList(projectId, environmentId),
  );
}

async function containerList(
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
