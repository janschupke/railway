"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { spinDown } from "@/app/dashboard/actions";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { PendingStatus } from "./ui/misc";
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
  onDone,
  onError,
}: {
  serviceId: string;
  displayName: string;
  projectId: string;
  environmentId: string;
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
