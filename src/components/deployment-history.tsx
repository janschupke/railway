"use client";

import { useEffect, useState } from "react";
import { History, Undo2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { rollbackContainer } from "@/app/dashboard/actions";
import { relativeTime } from "@/lib/format";
import type { LifecycleDialogAction } from "@/lib/container-actions";
import type { DeploymentHistoryEntry } from "@/lib/railway/types";
import { Banner } from "./ui/banner";
import { LifecycleActionDialog } from "./lifecycle-action-dialog";
import { StatusBadge } from "./status-badge";
import { Text } from "./ui/text";

/*
 * The verb, hoisted out of the JSX rather than written at the prop.
 *
 * `i18next/no-literal-string` runs in jsx-only mode and reads any string attribute as copy,
 * which is right far more often than it is wrong — every other call site passes a variable,
 * so this is the first literal. The fix is to stop writing copy-shaped text in JSX, not to
 * add `action` to the allowlist: that list describes what is structurally not copy, and
 * widening it would make the claim false for every component after this one.
 */
const ROLLBACK: LifecycleDialogAction = "rollback";

/**
 * What this panel knows about the service's deployment history.
 *
 * `failed` and an empty `ready` are deliberately distinct, and the sentences differ: one says
 * the read did not happen, the other says Railway has no history to show. Collapsing them
 * told anyone whose token cannot read `Query.deployments` that their service had never
 * deployed, which is both wrong and unactionable — so the route answers with a `refused` flag
 * beside the list rather than leaving the browser to infer it from an empty array.
 *
 * `failed` therefore covers two upstream shapes: the request not landing at all, and landing
 * with `refused` set. They are one state here because the sentence and the offer are the same
 * in both — there is no history to choose from, and this app cannot say what it would have
 * been.
 */
type HistoryState =
  | { status: "loading" }
  | { status: "ready"; entries: DeploymentHistoryEntry[] }
  | { status: "failed" };

/**
 * The deployments this container could go back to, and the control that goes.
 *
 * Read on expand rather than with the row. It costs a Railway round trip per service against
 * the rate limit that is the binding constraint on this whole app, so reading it for twenty
 * rows would be twenty requests for a panel nobody has opened — the same argument
 * `/api/service-variables` makes, and the same lane: a route handler, because it is the only
 * one of the three that gets the inbound `AbortSignal`, which a panel that can be collapsed
 * mid-request genuinely wants.
 *
 * Mounted only while the panel is open, so mount is the trigger and there is no `open` prop
 * to thread — the condition `edit-container-form.tsx` relies on for the same reason.
 *
 * **An entry Railway will not roll back to is rendered without a control, never dropped.**
 * The row that broke things is often the one immediately before the row someone is looking
 * for, and a list that silently omitted it would read as a history with holes in it. The
 * absence of the button is the answer, and it says so in words beside the badge rather than
 * as a disabled control — a disabled button is a promise that something would happen in
 * another state, and Railway saying no is not a state that changes.
 *
 * `canRollback` is asked, not derived. Railway answers it per deployment exactly as it
 * answers `canRedeploy`, so the rule about what is eligible belongs upstream rather than
 * being a second guess maintained here against a status enum that gains members without
 * notice.
 *
 * **There is no image on any row, and there cannot be.** `Deployment.meta` is an opaque
 * scalar, so a deployment will not say what it ran; a row is "the deployment from 14:32 that
 * succeeded". That is the honest form of the choice — see DEPLOYMENTS_QUERY.
 */
export function DeploymentHistory({
  serviceId,
  displayName,
  projectId,
  environmentId,
  currentDeploymentId,
}: {
  serviceId: string;
  displayName: string;
  projectId: string;
  environmentId: string;
  /**
   * The row's live deployment id, which marks one entry as the one running now.
   *
   * Passed in rather than inferred from the list. The newest deployment is not necessarily
   * the running one — a rollback is precisely the case where it is not — so ordering cannot
   * answer this and only the container can.
   */
  currentDeploymentId: string | null;
}) {
  const t = useTranslations("containers");
  const locale = useLocale();
  const [history, setHistory] = useState<HistoryState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      project: projectId,
      environment: environmentId,
      service: serviceId,
    });

    fetch(`/api/service-deployments?${params}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body: { deployments: DeploymentHistoryEntry[]; refused: boolean }) => {
        // A refused read is not an empty history — see HistoryState.
        setHistory(
          body.refused
            ? { status: "failed" }
            : { status: "ready", entries: body.deployments },
        );
      })
      .catch(() => {
        // An abort is the panel closing, not a failure — and the component is unmounting.
        if (controller.signal.aborted) return;
        setHistory({ status: "failed" });
      });

    return () => controller.abort();
  }, [projectId, environmentId, serviceId]);

  if (history.status === "loading") {
    return (
      <Text variant="caption" tone="subtle">
        {t("historyLoading")}
      </Text>
    );
  }

  /*
   * A refused read says so and points at Railway, rather than rendering an empty list that
   * would read as "this service has never deployed". `Deployments` is in
   * DEGRADING_OPERATIONS precisely so this branch exists.
   */
  if (history.status === "failed") {
    return <Banner tone="info">{t("historyFailed")}</Banner>;
  }

  if (history.entries.length === 0) {
    return (
      <Text variant="caption" tone="subtle">
        {t("historyEmpty")}
      </Text>
    );
  }

  /*
   * One deployment is not a history. Saying so is worth a sentence of its own: the generic
   * list would render a single row with no control on it, which looks like the control
   * failing rather than like there being nowhere to go back to.
   *
   * **And it has to BE the current one**, which this used to assume rather than check. The
   * copy says "the only deployment this service has had", and a lone entry that is not the
   * one the service is on is a different fact entirely — Railway's list is capped at
   * LIST.DEPLOYMENT_HISTORY and this app has already seen it answer with an id the service
   * has moved off. Falling through to the list is right in that case: the row renders with
   * its own rollback control, which is exactly what somebody in that position wants.
   */
  if (history.entries.length === 1 && history.entries[0]?.id === currentDeploymentId) {
    return (
      <Text variant="caption" tone="subtle">
        {t("historyOnlyCurrent")}
      </Text>
    );
  }

  return (
    <section>
      <Text
        asChild
        variant="caption"
        tone="subtle"
        className="flex items-center gap-1.5"
      >
        <h4 id={`history-${serviceId}`}>
          <History aria-hidden className="size-3.5" />
          {t("historyLabel", { name: displayName })}
        </h4>
      </Text>

      <ul aria-labelledby={`history-${serviceId}`} className="mt-1.5 space-y-1">
        {history.entries.map((entry) => {
          const current = entry.id === currentDeploymentId;
          /*
           * The catalog's placeholder rather than an em dash written here, on the rule
           * lib/format.ts states: a formatter returns the number and never the copy, and a
           * deployment Railway gave no timestamp for still has to name itself in the
           * confirmation sentence.
           */
          const when = relativeTime(entry.createdAt, locale) ?? t("noTimestamp");

          return (
            <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusBadge state={entry.state} rawStatus={entry.rawStatus} />

              <Text asChild variant="caption" tone="subtle" className="min-w-0 flex-1">
                <time
                  // Relative time is computed from the client clock; the server's differs.
                  suppressHydrationWarning
                  dateTime={entry.createdAt ?? undefined}
                >
                  {t("historyWhen", { when })}
                </time>
              </Text>

              {current ? (
                <Text variant="caption" tone="subtle">
                  {t("historyCurrent")}
                </Text>
              ) : entry.canRollback ? (
                <LifecycleActionDialog
                  action={ROLLBACK}
                  run={rollbackContainer}
                  icon={<Undo2 aria-hidden />}
                  serviceId={serviceId}
                  displayName={displayName}
                  projectId={projectId}
                  environmentId={environmentId}
                  /*
                   * The fourth field, and the only one any lifecycle verb posts beyond the
                   * three ids. It is a choice rather than a fact about the container, which
                   * is why it travels — and why `rollback` re-reads this same list on the
                   * server before it sends anything.
                   */
                  fields={{ deploymentId: entry.id }}
                  values={{ when }}
                  /*
                   * Every button in this list says "Roll back", so the accessible name has
                   * to name the row. It contains the visible label, which WCAG 2.5.3
                   * requires and which the row's own chevron docblock is about.
                   */
                  triggerLabel={t("historyRollbackLabel", { when })}
                />
              ) : (
                <Text variant="caption" tone="subtle">
                  {t("historyNotRollbackable")}
                </Text>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
