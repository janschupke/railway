"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/lib/action-result";
import type { LifecycleDialogAction } from "@/lib/container-actions";
import { useToast } from "./ui/toast";
import { Button } from "./ui/button";
import { onSubmitWith } from "./ui/form";
import { PendingStatus } from "./ui/misc";
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogRoot,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";

/**
 * The second confirm path: one sentence and two buttons.
 *
 * Stop, restart, redeploy and rollback are all reversible — the service, its variables and
 * its history survive every one of them — so they must not carry the destroy dialog's
 * type-the-name friction. Friction is priced in what it protects: typing a container's
 * name to stop it for ten minutes would teach people to type container names, which is the
 * habit the destroy dialog depends on them not having.
 *
 * They do still confirm, because all four interrupt a running service and the row they
 * sit on is one of many. AlertDialog is what makes that cheap and correct: focus trapped,
 * returned to the trigger on close, and announced as `alertdialog` so the sentence is read
 * before the buttons.
 *
 * One component for four verbs rather than four components, because nothing differs
 * between them except the copy and the mutation — and a per-verb component is four places
 * for the refresh, the toast and the pending window to drift apart.
 *
 * The body is imported statically, like the destroy dialog's: Radix traps focus in whatever
 * the content holds at the moment it opens, so a lazily-loaded body traps nothing and Tab
 * walks into the page behind it. Radix already defers *mounting* until open.
 */
export function LifecycleActionDialog({
  action,
  serviceId,
  displayName,
  projectId,
  environmentId,
  icon,
  run,
  fields,
  values,
  triggerLabel,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  startRefresh: callerRefresh,
}: {
  action: LifecycleDialogAction;
  serviceId: string;
  displayName: string;
  projectId: string;
  environmentId: string;
  /** Rendered inside the trigger, beside the visible label. */
  icon: React.ReactNode;
  /** The Server Action this dialog confirms. */
  run: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  /**
   * Anything this verb posts beyond the three ids, as hidden inputs.
   *
   * Empty for the three verbs that act on whatever deployment the service is running, which
   * the action reads off Railway. Rollback is the one that names a deployment in the past —
   * see `containerRollbackSchema`, and the paragraph `withManagedContainer` devotes to why
   * that is an exception rather than a precedent.
   */
  fields?: Record<string, string>;
  /**
   * ICU values for this verb's copy beyond `name`, which every verb has.
   *
   * Rollback's title names the deployment it is going back to, and it has to: four entries
   * in a history confirm through four dialogs whose only difference is that timestamp, and a
   * sentence that omitted it would be the same sentence for all four.
   */
  values?: Record<string, string>;
  /**
   * Accessible name for the trigger, when the visible label is not enough on its own.
   *
   * The three row controls sit beside a container name and read fine as "Stop". A rollback
   * trigger sits in a list of deployments where every row's button says "Roll back", so the
   * name has to say which one — WCAG 2.5.3 is why it must still *contain* the visible label.
   */
  triggerLabel?: string;
  /**
   * Opt-in control of the open state, for a caller that opens this from somewhere other
   * than the trigger below.
   *
   * Opt-in rather than required, because the second consumer still wants a trigger:
   * `deployment-history.tsx` renders one of these per rollback-eligible entry, in place,
   * with its own `triggerLabel`. Only the row menu needs to open one from outside — a
   * trigger rendered inside a menu item unmounts the moment the menu closes, which breaks
   * both the open and the focus restore.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Suppresses the trigger entirely, for a caller that supplies its own. */
  hideTrigger?: boolean;
  /**
   * The transition the post-action list refresh runs inside, when a caller owns one.
   *
   * The window between "the action returned" and "the refreshed list arrived" is one where
   * the row on screen is stale and its controls are live — a second click acts on a state
   * that no longer holds. This dialog closes that window itself when it owns its trigger,
   * because the trigger is what it can mark busy.
   *
   * A caller that replaced the trigger has replaced the thing that shows the busy state, so
   * it has to own the transition too. One transition in the parent covers every verb on the
   * row, which is what `e2e/skeleton.spec.ts` asserts: no control anywhere on a row is live
   * while a stale list is still on screen.
   */
  startRefresh?: React.TransitionStartFunction;
}) {
  const t = useTranslations("lifecycle");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const { toast } = useToast();
  const [selfOpen, setSelfOpen] = useState(false);
  /*
   * The merged value, read by BOTH Radix and the body gate below.
   *
   * Reading the controlled prop in one place and `selfOpen` in the other is the regression
   * `confirm-destroy-dialog.tsx` documents: the dialog mounts with an empty content, and an
   * empty AlertDialogContent traps no focus, so Tab walks straight into the page behind it.
   * `e2e/keyboard.spec.ts` is what catches it.
   */
  const open = controlledOpen ?? selfOpen;
  const setOpen = (next: boolean) => {
    setSelfOpen(next);
    onOpenChange?.(next);
  };
  const [pending, startTransition] = useTransition();
  /*
   * The action has returned but the row is still the old one until the refreshed list
   * arrives, and its trigger is live — a second click would act on a state that no longer
   * holds. The transition makes that window visible and closes it; Button derives
   * aria-busy and disabled from `pending` already. Same reasoning as the destroy dialog.
   */
  const [selfRefreshing, startSelfRefresh] = useTransition();
  // The caller's transition wins when there is one — see `startRefresh` above. `refreshing`
  // is then always false, and the trigger it would have marked is not rendered anyway.
  const refresh = callerRefresh ?? startSelfRefresh;
  const refreshing = callerRefresh ? false : selfRefreshing;

  /*
   * `name` is every verb's, and a verb's own values are merged over it rather than under —
   * so a future verb that needed to say something else about the container could, and the
   * default is not silently unreachable.
   */
  const copyValues = { name: displayName, ...values };

  const submit = (formData: FormData) => {
    startTransition(async () => {
      const result = await run(null, formData);
      if (result.ok) {
        toast({ title: result.message, tone: "success" });
        setOpen(false);
        refresh(() => router.refresh());
      } else {
        toast({
          title: t("failedTitle"),
          description: result.error,
          tone: "error",
        });
      }
    });
  };

  return (
    <AlertDialogRoot open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
        <AlertDialogTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            pending={refreshing}
            pendingLabel={t("refreshPending")}
            aria-label={triggerLabel}
          >
            {icon}
            {t(`${action}.trigger`)}
          </Button>
        </AlertDialogTrigger>
      )}

      <AlertDialogContent>
        {/* Mounted only while open, which is also what resets the pending state. */}
        {open && (
          <>
            <AlertDialogTitle>{t(`${action}.title`, copyValues)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(`${action}.description`)}
            </AlertDialogDescription>

            <form onSubmit={onSubmitWith(submit)} className="mt-4">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="environmentId" value={environmentId} />
              <input type="hidden" name="serviceId" value={serviceId} />
              {/*
                After the three ids, never before, so a verb's own field cannot shadow one of
                them: FormData keeps both entries and `formField` reads the first.
              */}
              {Object.entries(fields ?? {}).map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}

              <PendingStatus
                className="sr-only"
                label={pending ? t(`${action}.announce`, copyValues) : undefined}
              />

              <AlertDialogFooter>
                <AlertDialogCancel asChild>
                  {/* Dismissing mid-flight unmounts the form and strands the request. */}
                  <Button variant="ghost" disabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                </AlertDialogCancel>
                {/*
                  Deliberately not an AlertDialogAction: that closes the dialog on click,
                  unmounting the form mid-submit and discarding the pending state.
                */}
                <Button
                  type="submit"
                  variant="primary"
                  pending={pending}
                  pendingLabel={t(`${action}.submitPending`)}
                >
                  {t(`${action}.submit`)}
                </Button>
              </AlertDialogFooter>
            </form>
          </>
        )}
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}
