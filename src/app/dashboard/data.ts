import "server-only";

import { cache } from "react";
import { getTranslations } from "next-intl/server";
import { env } from "@/env";
import { getSession } from "@/lib/auth/server";
import {
  getEnvironmentVolumes,
  getProjectContainers,
  getProjectMetrics,
  listProjects,
} from "@/lib/railway/api";
import { RailwayApiError, type RailwayErrorKind } from "@/lib/railway/errors";
import { cachedRegions } from "@/lib/railway/regions";
import { reportError } from "@/lib/report-error";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import type { MessageKey } from "@/lib/messages";
import type {
  Container,
  ContainerMetrics,
  ContainerVolume,
  RailwayEnvironment,
  RailwayProject,
  RailwayWorkspace,
  RegionOption,
  WorkspaceSpend,
} from "@/lib/railway/types";

export type DashboardShell = {
  user: { name?: string; email?: string };
  projects: RailwayProject[];
  /**
   * Where a new project could be created, for the create dialog's workspace select.
   *
   * Empty for two situations that need different answers on screen and are told apart by
   * `missingScopes` rather than by this: an account with no workspaces, and a token whose
   * `workspace:viewer` was withheld — which reads as no workspaces from here.
   */
  workspaces: RailwayWorkspace[];
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
  /**
   * Current usage per service id, for whichever containers Railway had a sample for.
   *
   * Keyed rather than merged onto the containers, so a value that changes every couple of
   * minutes never reaches the watcher's fingerprint or the list's filter key. Empty when
   * metrics were refused or failed — which reads identically to "no samples yet", and is
   * meant to: the row renders an em dash either way.
   */
  metrics: Record<string, ContainerMetrics>;
  /**
   * Where each container keeps its data, for whichever containers have a volume.
   *
   * Keyed for the same reason `metrics` is — `currentSizeMB` moves as a database is written
   * to, and neither the watcher's fingerprint nor the list's filter key may observe a value
   * like that. Empty when the read was refused, which reads identically to "no container
   * here has a volume": the row shows nothing extra, and the destroy dialog offers no
   * choice, which keeps the data.
   */
  volumes: Record<string, ContainerVolume>;
  /** Workspace-wide, and null for a personal project or an unscoped token. */
  spend: WorkspaceSpend | null;
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

/**
 * Memoized for the render, not cached across requests.
 *
 * Two callers want this list in one render now: the container section, and the spin-up
 * form's local duplicate check. `cache` is what keeps that one Railway round trip rather
 * than two — it is per-render state, so nothing here contradicts ADR-4; a second render a
 * millisecond later still asks Railway.
 *
 * The memo is keyed on the arguments, so both call sites must pass the same two strings.
 * `""` where the other passes a real id is a silent second round trip, which is why
 * page.tsx guards on the ids being present rather than coercing them.
 */
const containerList = cache(
  async (projectId: string, environmentId: string): Promise<ContainerListData> => {
    const session = await getSession();
    // The shell already redirected an anonymous request; this is a guard, not a path.
    if (!session) {
      return { containers: [], error: null, metrics: {}, volumes: {}, spend: null };
    }

    /*
     * Issued alongside the container read, never after it, and caught separately.
     *
     * Two independent failure modes that must not become one. A refused or broken metrics read
     * has to leave the list exactly as it was — the whole argument for this being an optional
     * field — and a broken container read has to keep saying so even if usage answered fine.
     * Sequencing them would also put a second Railway round trip in front of the list on every
     * render, which is the latency the Suspense boundary exists to avoid.
     *
     * Started before the container read is awaited so the two overlap. The rejection is
     * attached here rather than left floating: an unhandled rejection from a read this app
     * treats as optional would crash the process.
     */
    const usage = env().METRICS_POLL_MS
      ? getProjectMetrics(session.accessToken, projectId, environmentId).catch(
          (error: unknown) => {
            // Debug for the same reason api.ts logs a refusal at debug: this runs on every
            // render, and a readout the app degrades out of is not an incident.
            log.debug("dashboard.metrics_failed", { error });
            return { metrics: {}, spend: null };
          },
        )
      : Promise.resolve({ metrics: {}, spend: null });

    /*
     * Third read, issued alongside the other two rather than after either.
     *
     * NOT gated on METRICS_POLL_MS, unlike `usage` above, and the difference is what each
     * one is for. That switch exists to turn off a *polled* readout on a plan whose rate
     * limit cannot afford it; a volume is a property of the container rather than a sample
     * of it, and the destroy dialog's offer to delete the data depends on knowing it is
     * there. Turning the usage readout off must not quietly start orphaning volumes.
     *
     * Degrades to `{}`, which is the same value "no container here has a volume" produces —
     * deliberately, and safe because every consequence of the empty answer is the
     * conservative one. See DEGRADING_OPERATIONS in lib/railway/schema-policy.ts.
     */
    const storage = getEnvironmentVolumes(session.accessToken, environmentId).catch(
      (error: unknown) => {
        log.debug("dashboard.volumes_failed", { error });
        return {} as Record<string, ContainerVolume>;
      },
    );

    try {
      /*
       * No signal, and that is a framework limit rather than an oversight — see the note
       * below before adding one.
       *
       * `getProjectContainers` takes an optional AbortSignal and the watch route passes one,
       * so this reads like an inconsistency worth closing. It is not: Next 16 exposes the
       * inbound request's signal only on `NextRequest`, which exists in a route handler and
       * nowhere else. A Server Component, a data loader and a Server Action have no
       * accessor for it — `next/server` exports none, and the signals inside app-render are
       * the prerender and cache ones, which say nothing about the client hanging up. So a
       * project switch remounts the Suspense boundary and this call runs on to its own
       * completion, up to NETWORK.MAX_ATTEMPTS × REQUEST_TIMEOUT_MS.
       *
       * A synthetic deadline was the obvious substitute and is deliberately not here: it
       * would bound the render that nobody is waiting for by failing the one that somebody
       * is, since the two are indistinguishable from this side. The retry backoff is now
       * cancellable for the callers that *do* hold a real signal (see `backoff` in
       * lib/railway/client.ts), which is the part of this that was genuinely broken.
       *
       * If a Next release exposes a request signal, this is the first place it belongs.
       */
      const { containers } = await getProjectContainers(
        session.accessToken,
        projectId,
        environmentId,
      );
      return { containers, error: null, volumes: await storage, ...(await usage) };
    } catch (error) {
      const t = await getTranslations();
      return {
        containers: [],
        error: describe(t, error, "errors.containersFailed"),
        // Awaited even on this path so neither request can outlive the render that started
        // it, and spread so a spend figure survives a failed container read — these are
        // independent reads and the UI shows them in different places.
        volumes: await storage,
        ...(await usage),
      };
    }
  },
);

/**
 * The names of this app's own containers in one environment, prefix already stripped.
 *
 * All that survives of the name lookup `spinUp` used to make before every create: the
 * spin-up form checks what someone has typed against this and says so inline. Reads
 * through `loadContainers`, so it shares that call's request scope and its memo and costs
 * no Railway round trip of its own.
 *
 * Cannot reject, and must not be made to. The result is handed to a client component as
 * an unawaited promise, and a rejected one crossing that boundary surfaces as an error in
 * the client tree rather than as a check that quietly did not run. `containerList`
 * catching everything is what makes that safe.
 */
export async function managedNames(
  projectId: string,
  environmentId: string,
): Promise<string[]> {
  const { containers } = await loadContainers(projectId, environmentId);
  // Only this app's own names can be taken: it prefixes what it creates, and a service
  // created elsewhere is listed for context but occupies none of that namespace.
  return containers.filter((c) => c.managed).map((c) => c.displayName);
}

/**
 * Where a container may be created, for the spin-up form's region select.
 *
 * Carries `managedNames`' contract above word for word: it cannot reject, and must not be
 * made to. The result crosses into a client component as an unawaited promise, and a
 * rejected one surfaces there as an error in the client tree rather than as a choice that
 * quietly did not appear — so everything is caught here, where the answer to a failure is a
 * designed one.
 *
 * `[]` is that designed answer rather than a failure: the select renders disabled with a
 * reason and Railway picks the region, which is what happened before this app offered a
 * choice at all. See DEGRADING_OPERATIONS in lib/railway/schema-policy.ts.
 *
 * Unlike `managedNames` it does not share `loadContainers`' memo — nothing else reads
 * regions — so it is the one read on this page with a cache of its own. See
 * lib/railway/regions.ts for why that cache exists and what it costs.
 */
export async function deployRegions(projectId: string): Promise<RegionOption[]> {
  try {
    const session = await getSession();
    if (!session) return [];
    return await cachedRegions(session.accessToken, session.user.id, projectId);
  } catch (error) {
    // Debug, beside the two reads above and for their reason: this runs on every render, and
    // a choice the app degrades out of by design is not an incident.
    log.debug("dashboard.regions_failed", { error });
    return [];
  }
}
