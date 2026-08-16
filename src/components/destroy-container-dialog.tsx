"use client";

import { useTranslations } from "next-intl";
import { spinDown } from "@/app/dashboard/actions";
import { ConfirmDestroyDialog } from "./confirm-destroy-dialog";

/**
 * Destroy confirmation for one container.
 *
 * Everything structural lives in `ConfirmDestroyDialog`; this decides what the copy says
 * and what makes the button safe to press.
 */
export function DestroyContainerDialog({
  serviceId,
  displayName,
  projectId,
  environmentId,
  volumeSize,
  disabled,
  open,
  onOpenChange,
  hideTrigger,
  startRefresh,
}: {
  serviceId: string;
  displayName: string;
  projectId: string;
  environmentId: string;
  /**
   * Rendered size of this container's volume, or undefined when it has none.
   *
   * A formatted string rather than a number, because the figure and its unit are composed
   * from the catalog one level up — see the row's readout. Undefined renders no checkbox at
   * all: no field is posted, and the action keeps whatever it finds.
   */
  volumeSize?: string;
  disabled?: boolean;
  /**
   * Passed straight through to `ConfirmDestroyDialog`, for the row menu.
   *
   * Not re-argued here — see that component, which is where the opt-in control, the wrapped
   * `onOpenChange` and the lifted refresh transition all state their reasons.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  startRefresh?: React.TransitionStartFunction;
}) {
  const t = useTranslations("destroy");
  const tOne = useTranslations("destroy.one");

  return (
    <ConfirmDestroyDialog
      action={spinDown}
      hiddenFields={{ projectId, environmentId, serviceId }}
      /*
       * The container's own name, matched exactly. It is an identifier the reader is
       * looking at while they type it, so case is not a guess — and this app's managed
       * names are lowercase slugs, so there is nothing to trip over.
       */
      confirmToken={displayName}
      matchCase
      checkbox={
        volumeSize === undefined
          ? undefined
          : {
              label: tOne("deleteDataLabel", { size: volumeSize }),
              hint: tOne("deleteDataHint"),
              /*
               * Checked by default, which is the decision worth defending. The volume was
               * created by this app as part of creating this container, it holds only what
               * that container wrote, and leaving it behind is billable storage that
               * vanishes from this UI the moment its service does — the app lists
               * containers, and an orphan volume is not one. So the default is the outcome
               * with no invisible remainder, and the friction guarding it is the same typed
               * name that guards the service.
               */
              defaultChecked: true,
            }
      }
      triggerDisabled={disabled}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
      {...(hideTrigger === undefined ? {} : { hideTrigger })}
      {...(startRefresh ? { startRefresh } : {})}
      copy={{
        trigger: tOne("trigger"),
        title: tOne("title", { name: displayName }),
        description: tOne("description"),
        confirmLabel: t("confirmLabel", { token: displayName }),
        submit: tOne("submit"),
        submitPending: tOne("submitPending"),
        announce: tOne("announce", { name: displayName }),
        failedTitle: tOne("failedTitle"),
        refreshPending: t("refreshPending"),
      }}
    />
  );
}
