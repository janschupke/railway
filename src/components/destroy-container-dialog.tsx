"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useToast } from "./ui/toast";
import { Button } from "./ui/button";
import { DestroyContainerForm } from "./destroy-container-form";
import {
  AlertDialogContent,
  AlertDialogRoot,
  AlertDialogTrigger,
} from "./ui/alert-dialog";

/*
 * The form is imported statically, deliberately.
 *
 * Loading it with `next/dynamic` saved ~10 kB gzip, but it broke the focus trap: Radix
 * traps focus in whatever AlertDialogContent contains at the moment it opens, and for
 * the tick before the chunk arrived that was nothing — so Tab walked straight out of
 * the dialog and into the page behind it. e2e/keyboard.spec.ts caught it.
 *
 * Radix already defers the *mounting* of this subtree until the dialog opens, so the
 * runtime cost was never the issue; only the module weight was, and a working focus
 * trap is worth more than 10 kB.
 */

/**
 * Destroy confirmation.
 *
 * Radix AlertDialog rather than an inline form: it traps focus, restores it to the
 * trigger on close, and is announced as `alertdialog` so the consequence is read before
 * the buttons.
 */
export function DestroyContainerDialog({
  serviceId,
  displayName,
  projectId,
  environmentId,
  volumeSize,
  disabled,
}: {
  serviceId: string;
  displayName: string;
  projectId: string;
  environmentId: string;
  /** Formatted size of this container's volume; undefined when it has none. */
  volumeSize?: string;
  disabled?: boolean;
}) {
  const t = useTranslations("destroy");
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  /*
   * The destroy succeeded but the row is still on screen until the refreshed list
   * arrives, and its trigger was still live — a second click hit a service that no
   * longer exists and answered with an error. The transition makes that window visible
   * and closes it; Button derives aria-busy and disabled from `pending` already.
   */
  const [refreshing, startRefresh] = useTransition();

  return (
    <AlertDialogRoot open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="danger"
          size="sm"
          disabled={disabled}
          pending={refreshing}
          pendingLabel={t("refreshPending")}
        >
          <Trash2 aria-hidden />
          {t("trigger")}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        {/* Mounted only while open, which is also what resets the typed confirmation. */}
        {open && (
          <DestroyContainerForm
            serviceId={serviceId}
            displayName={displayName}
            projectId={projectId}
            environmentId={environmentId}
            volumeSize={volumeSize}
            onDone={(message) => {
              toast({ title: message, tone: "success" });
              setOpen(false);
              startRefresh(() => router.refresh());
            }}
            onError={(message) =>
              toast({
                title: t("failedTitle"),
                description: message,
                tone: "error",
              })
            }
          />
        )}
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}
