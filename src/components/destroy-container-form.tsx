"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { spinDown } from "@/app/dashboard/actions";
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
 * The body of the destroy confirmation, split out so it can be loaded on open.
 *
 * Typing the container name is the guard: this permanently deletes infrastructure, and
 * a single mis-aimed click should not be able to do that. The action still re-checks
 * ownership on the server — this is friction, not authorisation.
 *
 * The action is invoked inside a transition rather than through useActionState so the
 * dialog can close on success. Reacting to the result in an effect would mean calling
 * setState from an effect body, which cascades renders.
 */
export function DestroyContainerForm({
  serviceId,
  displayName,
  projectId,
  environmentId,
  volumeSize,
  onDone,
  onError,
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
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const t = useTranslations("destroy");
  const tCommon = useTranslations("common");
  const [confirmText, setConfirmText] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    startTransition(async () => {
      const result = await spinDown(null, formData);
      if (result.ok) onDone(result.message);
      else onError(result.error);
    });
  };

  return (
    <>
      <AlertDialogTitle>{t("title", { name: displayName })}</AlertDialogTitle>
      <AlertDialogDescription>{t("description")}</AlertDialogDescription>

      <form action={submit} className="mt-4">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="environmentId" value={environmentId} />
        <input type="hidden" name="serviceId" value={serviceId} />

        {/*
          Above the typed confirmation, not below it: this changes what the button on the
          other side of that field is about to do, so it has to be read before the field is
          filled in rather than after.

          Checked by default, which is the decision worth defending. The volume was created
          by this app as part of creating this container, it holds only what that container
          wrote, and leaving it behind is billable storage that vanishes from this UI the
          moment its service does — the app lists containers, and an orphan volume is not
          one. So the default is the outcome with no invisible remainder, and the friction
          that guards it is the same typed name that guards the service.

          Rendered only when there is a volume, so unchecking it is a decision someone made
          rather than a default they inherited; the two toast sentences in `spinDown` state
          which way it went either way.
        */}
        {volumeSize !== undefined && (
          <div className="mb-3 space-y-1">
            <Checkbox
              name="deleteData"
              defaultChecked
              disabled={pending}
              label={t("deleteDataLabel", { size: volumeSize })}
            />
            <Text variant="caption" tone="subtle">
              {t("deleteDataHint")}
            </Text>
          </div>
        )}

        <Field label={t("confirmLabel", { name: displayName })}>
          {(field) => (
            <Input
              {...field}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={displayName}
              autoComplete="off"
            />
          )}
        </Field>

        <PendingStatus
          className="sr-only"
          label={pending ? t("announce", { name: displayName }) : undefined}
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
            disabled={confirmText.trim() !== displayName}
            pending={pending}
            pendingLabel={t("submitPending")}
          >
            {t("submit")}
          </Button>
        </AlertDialogFooter>
      </form>
    </>
  );
}
