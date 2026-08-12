"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { spinDown } from "@/app/dashboard/actions";
import { useToast } from "./ui/toast";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
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
 * Destroy confirmation.
 *
 * Typing the container name is the guard: this permanently deletes infrastructure, and
 * a single mis-aimed click should not be able to do that. The action still re-checks
 * ownership on the server — this is friction, not authorisation.
 *
 * The action is invoked inside a transition rather than through useActionState so the
 * dialog can close on success. Reacting to the result in an effect would mean calling
 * setState from an effect body, which cascades renders.
 */
export function DestroyContainerDialog({
  serviceId,
  displayName,
  projectId,
  environmentId,
  disabled,
}: {
  serviceId: string;
  displayName: string;
  projectId: string;
  environmentId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    startTransition(async () => {
      const result = await spinDown(null, formData);
      if (result.ok) {
        toast({ title: result.message, tone: "success" });
        setOpen(false);
        setConfirmText("");
        router.refresh();
      } else {
        toast({
          title: "Could not destroy container",
          description: result.error,
          tone: "error",
        });
      }
    });
  };

  return (
    <AlertDialogRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirmText("");
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="danger" size="sm" disabled={disabled}>
          <Trash2 aria-hidden />
          Destroy
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogTitle>Destroy {displayName}?</AlertDialogTitle>
        <AlertDialogDescription>
          This permanently deletes the service and its deployment history from Railway.
          It cannot be undone.
        </AlertDialogDescription>

        <form action={submit} className="mt-4">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="environmentId" value={environmentId} />
          <input type="hidden" name="serviceId" value={serviceId} />

          <Field label={`Type "${displayName}" to confirm`}>
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
            label={pending ? `Destroying ${displayName}…` : undefined}
          />

          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              {/* Dismissing mid-flight unmounts the form and strands the request. */}
              <Button variant="ghost" disabled={pending}>
                Cancel
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
              pendingLabel="Destroying…"
            >
              Destroy permanently
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}
