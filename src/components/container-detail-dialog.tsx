"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Info, Pencil } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { relativeTime } from "@/lib/format";
import type {
  Container,
  ContainerMetrics,
  ContainerVolume,
  ContainerState,
} from "@/lib/railway/types";
import { ContainerMetricsReadout } from "./container-metrics";
import { EditContainerForm } from "./edit-container-form";
import { RailwayServiceLink } from "./railway-service-link";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Text } from "./ui/text";
import { useToast } from "./ui/toast";

/*
 * `EditContainerForm` is imported statically, deliberately — the decision the destroy
 * dialog documents. Radix traps focus in whatever the content holds at the moment it
 * opens, so a `next/dynamic` body traps nothing for the tick before its chunk lands and
 * Tab walks straight into the page behind it. `e2e/keyboard.spec.ts` catches exactly that.
 *
 * Radix already defers *mounting* the subtree until the dialog opens, so nothing here runs
 * for a row nobody has looked at; only the module weight was ever at stake.
 */

/** One label/value pair in the facts list. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Text asChild variant="caption" tone="subtle">
        <dt>{label}</dt>
      </Text>
      {/* `mono` on the value: an image reference, a service id and a hostname are all
          strings a reader compares character by character or copies out whole. */}
      <Text asChild variant="mono">
        <dd className="break-all">{children}</dd>
      </Text>
    </div>
  );
}

/**
 * Everything this app knows about one container, and — when it may — the form to change it.
 *
 * ## Why one dialog rather than a detail view and an edit dialog
 *
 * Every row can open this; only a managed row can reach its edit mode. That is the point.
 * Before this, an external container had no way to see what the app knew about it, and
 * "this app cannot change this service" was something a reader had to infer from a missing
 * Edit button — an absence is not a sentence, and inferring one from it is exactly the kind
 * of guess that reads as the app being broken. Here the constraint is written down, in the
 * place a reader goes to look at the container.
 *
 * The edit surface itself did not change: `EditContainerForm` is mounted verbatim, still
 * owning its own variables read, its controlled inputs and its submit. Only its host moved.
 * `edit-container-dialog.tsx` is gone rather than kept alongside, because two components
 * that mount the same form is the arrangement that drifts.
 *
 * **Read mode is not a weaker edit mode.** It renders text, not disabled inputs. A disabled
 * field is a promise that something would happen in another state, and for a service this
 * app did not create there is no such state — the server refuses every verb through
 * `withManagedContainer` whatever the browser sends.
 *
 * `DialogRoot` rather than `AlertDialogRoot`: an alert dialog interrupts, reads its
 * description before anything else and offers no dismiss affordance, because the answer is
 * meant to be deliberate. This is something a reader opened to look at.
 */
export function ContainerDetailDialog({
  container,
  metrics,
  volume,
  state,
  projectId,
  environmentId,
  disabled,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  startRefresh: callerRefresh,
}: {
  container: Container;
  metrics: ContainerMetrics | undefined;
  volume: ContainerVolume | undefined;
  /**
   * The row's live state, which prefers the stream over the last server render — so the
   * badge in here agrees with the badge on the row rather than with a stale fetch.
   */
  state: ContainerState;
  projectId: string;
  environmentId: string;
  /** Set while the container is on its way out, when there is nothing left to edit. */
  disabled?: boolean;
  /**
   * Opt-in control of the open state, for a caller that opens this from somewhere other
   * than the trigger below — the row menu, whose trigger unmounts when the menu closes.
   *
   * Opt-in rather than required so this component's own tests keep clicking a real trigger.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Suppresses the trigger entirely, for a caller that supplies its own. */
  hideTrigger?: boolean;
  /** The transition the post-edit list refresh runs inside, when a caller owns one. */
  startRefresh?: React.TransitionStartFunction;
}) {
  const t = useTranslations("containerDetail");
  const tContainers = useTranslations("containers");
  const tEdit = useTranslations("editContainer");
  const tStates = useTranslations("states");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const { toast } = useToast();
  const [selfOpen, setSelfOpen] = useState(false);
  /*
   * The merged value, read by Radix AND by the `{open && …}` body gate below. Splitting the
   * two mounts an empty DialogContent, which traps no focus — the regression
   * `confirm-destroy-dialog.tsx` documents and `e2e/keyboard.spec.ts` catches.
   */
  const open = controlledOpen ?? selfOpen;
  const [editing, setEditing] = useState(false);
  /*
   * The edit has returned but the row still shows the old name and image until the
   * refreshed list arrives, and the trigger is live — reopening now would prefill the form
   * from a container description that is already stale. The transition makes that window
   * visible and closes it; Button derives aria-busy and disabled from `pending` already.
   *
   * This is also what re-keys the log stream. A changed image redeploys, and the new
   * deployment id reaches the row through this refresh — `useDeploymentStream` keys on the
   * id alone, so it re-attaches on its own once the row re-renders with the new one.
   */
  const [selfRefreshing, startSelfRefresh] = useTransition();
  // The caller's transition wins when there is one. `refreshing` is then always false, and
  // the trigger it would have marked is not rendered anyway.
  const refresh = callerRefresh ?? startSelfRefresh;
  const refreshing = callerRefresh ? false : selfRefreshing;

  /** Only a managed container has an edit mode to be in. */
  const canEdit = container.managed && !disabled;

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        setSelfOpen(next);
        // A dialog reopened after an edit was abandoned must not still be in edit mode.
        if (!next) setEditing(false);
        // Wrapped rather than replaced, so the edit-mode reset above cannot be switched off
        // by a caller that supplies a handler of its own.
        onOpenChange?.(next);
      }}
    >
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            pending={refreshing}
            pendingLabel={tEdit("refreshPending")}
          >
            <Info aria-hidden />
            {t("trigger")}
          </Button>
        </DialogTrigger>
      )}

      <DialogContent size="panel" closeLabel={tCommon("close")}>
        {/* Mounted only while open, which is also what re-reads the variables and resets
            anything typed into a form that was dismissed rather than submitted. */}
        {open && (
          <div className="flex min-h-0 grow flex-col gap-4 overflow-y-auto">
            <div>
              <DialogTitle>{t("title", { name: container.displayName })}</DialogTitle>
              <DialogDescription>
                {editing ? tEdit("description") : t("description")}
              </DialogDescription>
            </div>

            {editing ? (
              <EditContainerForm
                serviceId={container.serviceId}
                displayName={container.displayName}
                image={container.image}
                // So the form can say when a stateful image is about to run with no
                // storage — editing cannot attach a volume. See its `volume` prop.
                volume={volume}
                projectId={projectId}
                environmentId={environmentId}
                onDone={(message) => {
                  toast({ title: message, tone: "success" });
                  setSelfOpen(false);
                  onOpenChange?.(false);
                  setEditing(false);
                  refresh(() => router.refresh());
                }}
                onError={(message) =>
                  toast({
                    title: tEdit("failedTitle"),
                    description: message,
                    tone: "error",
                  })
                }
              />
            ) : (
              <>
                {/*
                  Said out loud, and this is the half the app was missing.

                  The rule has always held on the server — every verb goes through
                  `withManagedContainer`, which re-reads the container list from Railway and
                  refuses before the verb runs. What a reader saw of it was a row with
                  fewer buttons than its neighbour, which states nothing about why.

                  It is now the ONLY place that sentence is said. The row used to carry a
                  tooltip answering the narrower question "where is my Destroy button", on a
                  control that existed only to hold it — and a tooltip is supplementary
                  detail by definition, which is the wrong register for a constraint. This
                  one covers every verb, because this is the view that holds all of them.

                  Info rather than warning: nothing is wrong. This is a service the app is
                  showing for context, and Railway's own page is where it can be changed.
                */}
                {!container.managed && <Banner tone="info">{t("notManaged")}</Banner>}

                {/*
                  A grid rather than the wrapping row the metrics readout uses. These are
                  static facts of differing lengths — an image reference next to a status
                  word — and a wrapping row puts the long one on its own line and leaves a
                  ragged gap beside the short one. Tracks keep the labels in a column a
                  reader can run their eye down.
                */}
                <dl className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-x-6 gap-y-3">
                  <Fact label={t("nameLabel")}>{container.displayName}</Fact>
                  {/*
                    The prefixed name, which is the ownership marker itself. Worth showing
                    precisely because it is the whole basis of the managed/external split —
                    a reader wondering why this app will not touch their service can see
                    the name it actually has in Railway.
                  */}
                  <Fact label={t("rawNameLabel")}>{container.rawName}</Fact>

                  <Fact label={t("sourceLabel")}>
                    {container.image ?? container.repo ?? tContainers("noSource")}
                  </Fact>

                  <Fact label={t("stateLabel")}>
                    {/* Both, because they answer different questions: the mapped state is
                        what this app acts on, and the raw status is what Railway said. */}
                    {container.rawStatus
                      ? t("stateValue", {
                          state: tStates(state),
                          raw: container.rawStatus,
                        })
                      : tStates(state)}
                  </Fact>

                  <Fact label={t("urlLabel")}>
                    {container.url ? (
                      <a
                        href={container.url}
                        target="_blank"
                        rel="noreferrer"
                        className="focus-ring link inline-flex items-center gap-1"
                      >
                        {container.url}
                        <ExternalLink aria-hidden className="size-3 shrink-0" />
                      </a>
                    ) : (
                      tCommon("noValue")
                    )}
                  </Fact>

                  <Fact label={t("serviceIdLabel")}>{container.serviceId}</Fact>

                  <Fact label={t("createdLabel")}>
                    {relativeTime(container.createdAt, locale) ?? tCommon("noValue")}
                  </Fact>
                  <Fact label={t("updatedLabel")}>
                    {relativeTime(container.updatedAt, locale) ?? tCommon("noValue")}
                  </Fact>
                </dl>

                {/*
                  The same readout the expanded row shows, rather than a second rendering of
                  the same four numbers. It already owns which of them apply in which state —
                  uptime only while running, the volume only when there is one — and a copy
                  here is how this dialog and that panel would come to disagree about the
                  same container.
                */}
                <ContainerMetricsReadout
                  metrics={metrics}
                  volume={volume}
                  state={state}
                  deployedAt={container.deployedAt}
                  name={container.displayName}
                />
              </>
            )}

            {!editing && (
              <div className="mt-auto flex flex-wrap justify-end gap-2 pt-2">
                <Button asChild variant="secondary" size="sm">
                  <RailwayServiceLink
                    projectId={projectId}
                    serviceId={container.serviceId}
                    environmentId={environmentId}
                  >
                    <ExternalLink aria-hidden />
                    {tContainers("openInRailway")}
                  </RailwayServiceLink>
                </Button>

                {/*
                  Rendered only when it would work, not disabled when it would not.

                  A disabled Edit is a promise that this container could be edited in some
                  other state, and for an external one there is no such state. The banner
                  above is what explains the absence — which is the whole reason this
                  dialog exists rather than the row simply having fewer buttons.
                */}
                {canEdit && (
                  <Button variant="primary" size="sm" onClick={() => setEditing(true)}>
                    <Pencil aria-hidden />
                    {tEdit("trigger")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
