"use client";

import { useTranslations } from "next-intl";
import { spinDownMany } from "@/app/dashboard/actions";
import type { Container } from "@/lib/railway/types";
import { ConfirmDestroyDialog } from "./confirm-destroy-dialog";
import { Text } from "./ui/text";

/**
 * The confirmation for destroying several containers at once.
 *
 * A separate entry point rather than a mode, because this one has to *show* what is about
 * to happen — the names, since the user picked them one at a time and may have picked one
 * by mistake — where the single destroy is already looking at its subject.
 *
 * The trigger is disabled rather than absent at an empty selection. It sits in a toolbar
 * above the list, and a control that came and went as rows were ticked would move the list
 * under the pointer doing the ticking; see the same argument for Clear in
 * container-filter-bar.tsx.
 */
export function BulkDestroyDialog({
  containers,
  projectId,
  environmentId,
  volumeCount,
  onDestroyed,
}: {
  /** The selected containers, in the order the list is currently showing them. */
  containers: Container[];
  projectId: string;
  environmentId: string;
  /**
   * How many of them Railway reports a volume for.
   *
   * A count rather than the sizes: the checkbox is one decision covering the whole batch,
   * and a list of individual sizes would invite the reading that it can be taken per
   * container. Zero renders no checkbox and posts no field, so a batch with no stored data
   * anywhere is not asked a question about it.
   */
  volumeCount: number;
  /** Clears the selection, which is the list's state rather than this dialog's. */
  onDestroyed: () => void;
}) {
  const t = useTranslations("destroy");
  const tMany = useTranslations("destroy.many");

  const count = containers.length;
  /*
   * A phrase, not the count on its own.
   *
   * This used to accept `String(count)` — one keystroke on a numeric keypad for an
   * irreversible action on up to fifty containers, where destroying one demands its whole
   * name. The count stays inside the phrase, so the property that choice was made for
   * survives: a miscounted selection is still the one fact this confirmation catches.
   *
   * "destroy" rather than "delete" because the trigger, the button and the toast all say
   * destroy — and `deleteData` is already taken, naming the checkbox for the volume.
   */
  const token = tMany("confirmToken", { count });

  return (
    <ConfirmDestroyDialog
      action={spinDownMany}
      hiddenFields={{
        projectId,
        environmentId,
        serviceId: containers.map((container) => container.serviceId),
      }}
      confirmToken={token}
      /*
       * Compared case-insensitively, where the single destroy compares exactly. A container
       * name is an identifier; this is prose, and the friction is meant to come from typing
       * twenty characters rather than from holding shift for the first one.
       */
      matchCase={false}
      checkbox={
        volumeCount === 0
          ? undefined
          : {
              label: tMany("deleteDataLabel", { count: volumeCount }),
              hint: tMany("deleteDataHint"),
              /*
               * Unchecked, which is the opposite of the single destroy's default and is the
               * same decision made about a different question. There, the reader is looking
               * at one container and the dialog names its volume and its size; here, one
               * tick covers up to fifty containers whose volumes the reader has not seen
               * individually. A default that wipes data nobody looked at is not the same
               * trade as a default that wipes data in front of them.
               */
              defaultChecked: false,
            }
      }
      extra={
        /*
         * The names, on screen, before anything is typed.
         *
         * Scrolls rather than truncates: a batch at the ceiling is fifty rows, and "and 44
         * more" would hide exactly the part of the selection a person is least sure about.
         */
        <Text asChild variant="caption" tone="subtle">
          <ul
            aria-label={tMany("listLabel")}
            className="border-border mb-3 max-h-40 overflow-y-auto rounded-md border px-3 py-2"
          >
            {containers.map((container) => (
              <li key={container.serviceId} className="truncate">
                {container.displayName}
              </li>
            ))}
          </ul>
        </Text>
      }
      triggerDisabled={count === 0}
      copy={{
        trigger: tMany("trigger"),
        title: tMany("title", { count }),
        description: tMany("description"),
        confirmLabel: t("confirmLabel", { token }),
        submit: tMany("submit", { count }),
        submitPending: tMany("submitPending"),
        announce: tMany("announce", { count }),
        failedTitle: tMany("failedTitle"),
        refreshPending: t("refreshPending"),
      }}
      onDestroyed={onDestroyed}
    />
  );
}
