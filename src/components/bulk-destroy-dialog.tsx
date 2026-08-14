"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Container } from "@/lib/railway/types";
import { useToast } from "./ui/toast";
import { Button } from "./ui/button";
import { BulkDestroyForm } from "./bulk-destroy-form";
import {
  AlertDialogContent,
  AlertDialogRoot,
  AlertDialogTrigger,
} from "./ui/alert-dialog";

/*
 * The form is imported statically, for the reason destroy-container-dialog.tsx spells out:
 * `next/dynamic` empties AlertDialogContent for the tick before the chunk lands, and Radix
 * traps focus in whatever it contains at the moment it opens — so Tab walked out of the
 * dialog and into the page behind it. e2e/keyboard.spec.ts is what caught that.
 */

/**
 * The confirmation for destroying several containers at once.
 *
 * A second dialog rather than a mode on the single one, and the split is where the two
 * genuinely differ: this one has to *show* what is about to happen — the names, since the
 * user picked them one at a time and may have picked one by mistake — where the single
 * destroy is already looking at its subject.
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
  /** How many of them Railway reports a volume for; see the form. */
  volumeCount: number;
  /** Clears the selection, which is the list's state rather than this dialog's. */
  onDestroyed: () => void;
}) {
  const t = useTranslations("destroy");
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  /*
   * The rows are still on screen until the refreshed list arrives, and the trigger stays
   * live — the same window the single destroy documents, except that here a second
   * submission would name several services that no longer exist.
   */
  const [refreshing, startRefresh] = useTransition();

  const count = containers.length;

  return (
    <AlertDialogRoot open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="danger"
          size="sm"
          disabled={count === 0}
          pending={refreshing}
          pendingLabel={t("refreshPending")}
        >
          <Trash2 aria-hidden />
          {t("bulkTrigger")}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        {/* Mounted only while open, which is also what resets the typed confirmation. */}
        {open && (
          <BulkDestroyForm
            containers={containers}
            projectId={projectId}
            environmentId={environmentId}
            volumeCount={volumeCount}
            onDone={(message) => {
              toast({ title: message, tone: "success" });
              setOpen(false);
              /*
               * Cleared before the refresh rather than after it. The selection is a set of
               * service ids and most of them are about to stop existing; leaving it in place
               * for the round trip would mean the toolbar counting rows that are already
               * gone.
               */
              onDestroyed();
              startRefresh(() => router.refresh());
            }}
            onError={(message) =>
              toast({
                title: t("bulkFailedTitle"),
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
