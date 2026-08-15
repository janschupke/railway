/**
 * One environment's containers, with their usage and their volumes.
 *
 * **`managedNames` is here rather than in a module of its own, and that is load-bearing.**
 * Its whole contract is reading through `containerList`'s `cache()` memo — the page calls
 * both on the same render, and separating them would silently double a Railway round trip
 * per dashboard load. The memo is the reason they are one subject.
 */

import "server-only";

import { cache } from "react";
import { getTranslations } from "next-intl/server";
import { env } from "@/env";
import { getSession } from "@/lib/auth/server";
import { getProjectMetrics } from "@/lib/railway/metrics";
import { getProjectContainers } from "@/lib/railway/projects";
import { getEnvironmentVolumes } from "@/lib/railway/volumes";
import { log } from "@/lib/logger";
import type { ContainerVolume } from "@/lib/railway/types";
import { withRequestScope } from "@/lib/log/request-scope";
import type { ContainerListData } from "./dashboard-types";
import { describe } from "./describe-error";

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
