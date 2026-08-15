import "server-only";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAccessToken } from "@/lib/auth/server";
import type { ActionResult } from "@/lib/action-result";
import { getProjectContainers } from "@/lib/railway/api";
import { log } from "@/lib/logger";
import { containerActionSchema } from "@/lib/validation";
import type { Container } from "@/lib/railway/types";
import { formField, toActionError } from "./action-form";

/**
 * The ownership boundary, and the only thing between a posted service id and a mutation.
 *
 * `withManagedContainer` re-reads the container list from Railway and refuses before the
 * verb's own callback runs, so a forged id fails even though the requester's own token
 * would happily perform the call. `resolveManagedTarget` is the same decision for one id
 * against a list already in hand, which is what a batch needs.
 *
 * Both are what `local/mutation-inside-ownership-guard` looks for: a mutation must sit
 * inside the callback, or inside a function that calls the resolver. See ADR-5.
 */

/**
 * The event names one lifecycle verb writes, spelled out rather than built.
 *
 * `subsystem.thing.outcome`, from a closed set, and as literals so that grepping the log
 * store for `container.stop_refused` finds the line that emits it — which a template over
 * the verb would not. See .ai/rules/errors-and-logging.md on why the cardinality here is
 * the point.
 */
export const LIFECYCLE_EVENTS = {
  destroy: {
    skipped: "container.destroy_skipped",
    refused: "container.destroy_refused",
    done: "container.destroyed",
    /*
     * Destroy alone carries a fourth outcome, because destroy alone is asked about several
     * containers at once. Everywhere else a refused mutation ends the request and reaches
     * the log through `reportError` under an `action` line; inside a batch it ends one
     * entry, the request goes on, and this is the only record that names which entry.
     */
    failed: "container.destroy_failed",
  },
  stop: {
    skipped: "container.stop_skipped",
    refused: "container.stop_refused",
    done: "container.stopped",
  },
  restart: {
    skipped: "container.restart_skipped",
    refused: "container.restart_refused",
    done: "container.restarted",
  },
  redeploy: {
    skipped: "container.redeploy_skipped",
    refused: "container.redeploy_refused",
    done: "container.redeployed",
  },
  edit: {
    skipped: "container.edit_skipped",
    refused: "container.edit_refused",
    done: "container.updated",
  },
  domain: {
    skipped: "container.domain_skipped",
    refused: "container.domain_refused",
    done: "container.domain_created",
  },
} as const;

export type LifecycleVerb = keyof typeof LIFECYCLE_EVENTS;

/** What the ownership boundary decided about one service id the browser posted. */
export type ManagedResolution =
  | { managed: true; target: Container }
  | { managed: false; reason: "gone" | "unmanaged" };

/**
 * The ownership boundary itself, for exactly one service.
 *
 * The resolver, and one of the two things `local/mutation-inside-ownership-guard`
 * recognises as having done the check. It is a function rather than two lines inside
 * `withManagedContainer` because
 * destroy can now be asked about several services at once, and the alternative was a second
 * copy of "find the service, refuse an unmanaged one" written for the batch — the second
 * implementation that rule exists to prevent, and the one that would have been subtly weaker
 * because it was written under a loop.
 *
 * Per service, and that is the property the bulk path depends on: a batch is a list of
 * individual decisions taken against one read, never one decision taken about a list.
 *
 * It logs nothing and reads nothing. The caller owns the log line, because the event name is
 * the verb's, and the caller owns the read, because a batch must not make one per service.
 */
export function resolveManagedTarget(
  containers: Container[],
  serviceId: string,
): ManagedResolution {
  const target = containers.find((c) => c.serviceId === serviceId);
  if (!target) return { managed: false, reason: "gone" };
  if (!target.managed) return { managed: false, reason: "unmanaged" };
  return { managed: true, target };
}

/**
 * The ownership boundary, for every action that changes a container that already exists.
 *
 * One helper rather than four copies, and the reason is the reason the rule exists at all:
 * a second implementation of "re-derive ownership from Railway's own response" is a second
 * chance to get it subtly wrong, and nothing in the types would notice. Everything a
 * lifecycle verb does differently happens inside `run`, after this has already decided the
 * caller may act on this service. `local/mutation-inside-ownership-guard` asserts that
 * every infrastructure-changing call sits inside the callback this hands the target to.
 *
 * The deployment id is deliberately not a form field. It comes off `target`, which is
 * Railway's answer to this request — the client posts a service id and nothing else is
 * trusted, exactly as ownership is not.
 */
export async function withManagedContainer(
  verb: LifecycleVerb,
  formData: FormData,
  run: (context: {
    accessToken: string;
    projectId: string;
    environmentId: string;
    target: Container;
    /**
     * Everything else in the environment, from the same read that found `target`.
     *
     * Only the edit verb uses it, and only to refuse a rename onto a name that is already
     * taken. Handed down rather than re-read: the list is already in hand, and a second
     * `getProjectContainers` would be a round trip spent re-learning what this one just
     * proved, against the rate limit that shapes every read in this app.
     */
    containers: Container[];
  }) => Promise<ActionResult>,
): Promise<ActionResult> {
  const t = await getTranslations();
  const events = LIFECYCLE_EVENTS[verb];

  const parsed = containerActionSchema.safeParse({
    projectId: formField(formData, "projectId"),
    environmentId: formField(formData, "environmentId"),
    serviceId: formField(formData, "serviceId"),
  });
  if (!parsed.success) {
    return { ok: false, error: t("actions.missingReference") };
  }

  const { projectId, environmentId, serviceId } = parsed.data;

  try {
    const accessToken = await requireAccessToken();

    /*
     * Re-derive ownership server-side. The client sends a service id and nothing else
     * is trusted: if the service was not created by this app, the mutation is refused
     * here even though the user's own token would happily perform it.
     *
     * Uncancellable for the same reason as the read in `create` above — see
     * `containerList` in ./data.ts. It is also the read this app would least want to give
     * a deadline to: a signal that fired here would have to refuse the action, never
     * fall through to one, so it buys a new failure mode for a check that must not fail
     * open.
     */
    const { containers } = await getProjectContainers(
      accessToken,
      projectId,
      environmentId,
    );
    const resolution = resolveManagedTarget(containers, serviceId);

    if (!resolution.managed) {
      if (resolution.reason === "gone") {
        log.info(events.skipped, {
          reason: "gone",
          project_id: projectId,
          service_id: serviceId,
        });
        revalidatePath("/dashboard");
        return { ok: false, error: t("actions.gone") };
      }
      /*
       * The ownership boundary refusing a request, at warn because it should never
       * happen through the UI — these controls are only rendered for managed services.
       * Silent, this was indistinguishable from a UI bug; named, it is the difference
       * between a stale page and someone posting service ids by hand.
       */
      log.warn(events.refused, {
        reason: "unmanaged",
        project_id: projectId,
        service_id: serviceId,
      });
      return { ok: false, error: t("actions.notManaged") };
    }

    return await run({
      accessToken,
      projectId,
      environmentId,
      target: resolution.target,
      containers,
    });
  } catch (error) {
    return toActionError(t, error);
  }
}

/**
 * The audit line every lifecycle verb writes when it has changed something.
 *
 * The same field set `container.created` uses, because these change billable
 * infrastructure too and the question asked of the log afterwards is the same one: who did
 * what, to which service, where.
 *
 * `extra` is scalars, which is not merely a convenience: it is `LogFields`' own rule
 * restated at the one place a verb gets to add to this record, so "edit adds a variable
 * count" is expressible here and "edit adds the variables" is not.
 */
export function logLifecycle(
  verb: LifecycleVerb,
  context: {
    projectId: string;
    environmentId: string;
    target: Container;
  },
  extra: Record<string, string | number | boolean | null | undefined> = {},
): void {
  log.info(LIFECYCLE_EVENTS[verb].done, {
    project_id: context.projectId,
    environment_id: context.environmentId,
    service_id: context.target.serviceId,
    service_name: context.target.rawName,
    ...extra,
  });
}
