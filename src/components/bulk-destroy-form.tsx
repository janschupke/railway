"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { spinDownMany } from "@/app/dashboard/actions";
import type { Container } from "@/lib/railway/types";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { PendingStatus } from "./ui/misc";
import { Text } from "./ui/text";
import {
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "./ui/alert-dialog";

/**
 * The body of the bulk destroy confirmation.
 *
 * Typing the **count** is the guard, where the single destroy asks for the name. Both are
 * friction rather than authorisation — the action re-derives ownership per service either
 * way — but the friction has to be proportionate to what is being asked for, and typing six
 * names is not six times more careful than typing one, it is five times more likely to be
 * abandoned or pasted through. The number is also the one fact about this batch a person can
 * get wrong by miscounting a list of ticked boxes, so it is the thing worth making them read.
 *
 * The names are shown rather than summarised for the same reason: the selection was built one
 * row at a time, possibly across a filter change, and this is the last place a stray tick is
 * visible before it is irreversible.
 */
export function BulkDestroyForm({
  containers,
  projectId,
  environmentId,
  volumeCount = 0,
  onDone,
  onError,
}: {
  containers: Container[];
  projectId: string;
  environmentId: string;
  /**
   * How many of these containers Railway reports a volume for.
   *
   * A count rather than the sizes: the checkbox is one decision covering the whole batch, and
   * a list of individual sizes would invite the reading that it can be taken per container.
   * Zero renders no checkbox and posts no field, so a batch with no stored data anywhere is
   * not asked a question about it.
   */
  volumeCount?: number;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const t = useTranslations("destroy");
  const tCommon = useTranslations("common");
  const [confirmText, setConfirmText] = useState("");
  const [pending, startTransition] = useTransition();

  const count = containers.length;

  const submit = (formData: FormData) => {
    startTransition(async () => {
      const result = await spinDownMany(null, formData);
      if (result.ok) onDone(result.message);
      else onError(result.error);
    });
  };

  return (
    <>
      <AlertDialogTitle>{t("bulkTitle", { count })}</AlertDialogTitle>
      <AlertDialogDescription>{t("bulkDescription")}</AlertDialogDescription>

      <form action={submit} className="mt-4">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="environmentId" value={environmentId} />
        {/*
          One repeated field rather than a joined string, which is the shape the variables
          editor established and the reason `formList` already exists on the action side:
          FormData preserves per-name order, so the list arrives as a list with no delimiter
          anyone has to escape and no index built into a field name.
        */}
        {containers.map((container) => (
          <input
            key={container.serviceId}
            type="hidden"
            name="serviceId"
            value={container.serviceId}
          />
        ))}

        {/*
          The names, on screen, before anything is typed.

          Scrolls rather than truncates: a batch at the ceiling is fifty rows, and "and 44
          more" would hide exactly the part of the selection a person is least sure about.
        */}
        <Text asChild variant="caption" tone="subtle">
          <ul
            aria-label={t("bulkListLabel")}
            className="border-border mb-3 max-h-40 overflow-y-auto rounded-md border px-3 py-2"
          >
            {containers.map((container) => (
              <li key={container.serviceId} className="truncate">
                {container.displayName}
              </li>
            ))}
          </ul>
        </Text>

        {/*
          Above the typed confirmation, for the reason the single destroy states: this changes
          what the button on the other side of that field is about to do.

          Unchecked by default, which is the opposite of the single destroy's decision and is
          the same decision made about a different question. There, the reader is looking at
          one container and the dialog can name its volume and its size; here, one tick covers
          up to fifty containers whose volumes the reader has not seen individually. A default
          that wipes data nobody looked at is not the same trade as a default that wipes data
          in front of them.
        */}
        {volumeCount > 0 && (
          <div className="mb-3 space-y-1">
            <Checkbox
              name="deleteData"
              disabled={pending}
              label={t("bulkDeleteDataLabel", { count: volumeCount })}
            />
            <Text variant="caption" tone="subtle">
              {t("bulkDeleteDataHint")}
            </Text>
          </div>
        )}

        <Field label={t("bulkConfirmLabel", { count })}>
          {(field) => (
            <Input
              {...field}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              /*
               * `inputMode`, not `type="number"`. A number input brings a spinner that would
               * let someone arrive at the right value without reading it, which is the whole
               * of what this field is for.
               */
              inputMode="numeric"
              placeholder={String(count)}
              autoComplete="off"
            />
          )}
        </Field>

        <PendingStatus
          className="sr-only"
          label={pending ? t("bulkAnnounce", { count }) : undefined}
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
            variant="danger"
            disabled={confirmText.trim() !== String(count)}
            pending={pending}
            pendingLabel={t("bulkSubmitPending")}
          >
            {t("bulkSubmit", { count })}
          </Button>
        </AlertDialogFooter>
      </form>
    </>
  );
}
