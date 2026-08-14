"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "./ui/button";
import { EditContainerForm } from "./edit-container-form";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { useToast } from "./ui/toast";

/*
 * The form is imported statically, deliberately — the same decision the destroy dialog
 * documents. Radix traps focus in whatever the content holds at the moment it opens, so a
 * `next/dynamic` body traps nothing for the tick before its chunk lands and Tab walks
 * straight into the page behind it. `e2e/keyboard.spec.ts` catches exactly that.
 *
 * Radix already defers *mounting* the subtree until the dialog opens, so nothing here runs
 * for a row nobody has edited; only the module weight was ever at stake.
 */

/**
 * Change what a container runs, without destroying it.
 *
 * `DialogRoot` rather than `AlertDialogRoot`, and the distinction is the one ui/dialog.tsx
 * draws: an alert dialog interrupts, reads its description before anything else and offers
 * no dismiss affordance, because the answer is meant to be deliberate. This is a form
 * somebody opened on purpose — Escape and a close button are the expected exits, and
 * announcing it as an alert would report an emergency to a screen-reader user who had
 * pressed "Edit".
 */
export function EditContainerDialog({
  serviceId,
  displayName,
  image,
  projectId,
  environmentId,
  disabled,
}: {
  serviceId: string;
  displayName: string;
  image: string | null;
  projectId: string;
  environmentId: string;
  disabled?: boolean;
}) {
  const t = useTranslations("editContainer");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
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
  const [refreshing, startRefresh] = useTransition();

  return (
    <DialogRoot open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          pending={refreshing}
          pendingLabel={t("refreshPending")}
        >
          <Pencil aria-hidden />
          {t("trigger")}
        </Button>
      </DialogTrigger>

      <DialogContent closeLabel={tCommon("close")}>
        {/* Mounted only while open, which is also what re-reads the variables and resets
            anything typed into a form that was dismissed rather than submitted. */}
        {open && (
          <>
            <DialogTitle>{t("title", { name: displayName })}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>

            <EditContainerForm
              serviceId={serviceId}
              displayName={displayName}
              image={image}
              projectId={projectId}
              environmentId={environmentId}
              onDone={(message) => {
                toast({ title: message, tone: "success" });
                setOpen(false);
                startRefresh(() => router.refresh());
              }}
              onError={(message) =>
                toast({ title: t("failedTitle"), description: message, tone: "error" })
              }
            />
          </>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
