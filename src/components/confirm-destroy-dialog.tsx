"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/lib/action-result";
import { useToast } from "./ui/toast";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Field } from "./ui/field";
import { onSubmitWith } from "./ui/form";
import { Input } from "./ui/input";
import { PendingStatus } from "./ui/misc";
import { Text } from "./ui/text";
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogRoot,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";

/*
 * The form is part of this component rather than a module of its own.
 *
 * It was split out "so it can be loaded on open", which meant `next/dynamic` — and that
 * was reverted, because Radix traps focus in whatever AlertDialogContent holds at the
 * moment it opens, and for the tick before the chunk arrived that was nothing, so Tab
 * walked out of the dialog and into the page behind it. e2e/keyboard.spec.ts caught it.
 * Radix already defers *mounting* until open, so the runtime cost was never the issue.
 *
 * With the dynamic import gone the split had no remaining reason, and it was costing two
 * files that were 70% the same as two other files. `LifecycleActionDialog` is one
 * self-contained dialog-and-form for the same reason.
 */

/** What the confirmation says, resolved by the caller from its own copy namespace. */
type DestroyCopy = {
  trigger: string;
  title: string;
  description: string;
  /** Quotes `confirmToken`; shared between both variants because only the token differs. */
  confirmLabel: string;
  submit: string;
  submitPending: string;
  announce: string;
  failedTitle: string;
  refreshPending: string;
};

/**
 * One container or fifty, behind the same typed confirmation.
 *
 * Radix AlertDialog rather than an inline form: it traps focus, restores it to the trigger
 * on close, and is announced as `alertdialog` so the consequence is read before the
 * buttons. Typing the token is friction, not authorisation — the action re-derives
 * ownership per service on the server either way.
 *
 * The action runs inside a transition rather than through `useActionState`, so the dialog
 * can close on success. Reacting to the result in an effect would mean calling setState
 * from an effect body, which cascades renders.
 *
 * Two differences between the single and bulk variants are deliberate rather than
 * incidental, and they are props rather than shared defaults for exactly that reason —
 * `checkbox.defaultChecked` and `matchCase`. Each is argued at its call site.
 */
export function ConfirmDestroyDialog({
  action,
  hiddenFields,
  confirmToken,
  matchCase,
  checkbox,
  extra,
  triggerDisabled,
  copy,
  onDestroyed,
}: {
  action: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  /**
   * The ids the action needs, as hidden inputs.
   *
   * An array becomes one repeated field rather than a joined string — the shape the
   * variables editor established and the reason `formList` exists on the action side.
   * FormData preserves per-name order, so a list arrives as a list with no delimiter
   * anyone has to escape and no index built into a field name.
   */
  hiddenFields: Record<string, string | readonly string[]>;
  /** What has to be typed before the button enables. */
  confirmToken: string;
  /**
   * Whether the token is compared exactly.
   *
   * True for a container name, which is an identifier the user is looking at. False for a
   * typed phrase, which is prose: the friction should come from typing twenty characters,
   * not from a capital letter.
   */
  matchCase: boolean;
  /** The stored-data question, when there is any stored data to ask about. */
  checkbox?: { label: string; hint: string; defaultChecked: boolean };
  /** Rendered above the checkbox; the bulk variant lists what it is about to destroy. */
  extra?: React.ReactNode;
  triggerDisabled?: boolean;
  copy: DestroyCopy;
  /** Runs before the refresh, when the caller holds selection state of its own. */
  onDestroyed?: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [pending, startTransition] = useTransition();
  /*
   * The destroy succeeded but the rows are still on screen until the refreshed list
   * arrives, and the trigger was still live — a second click hit a service that no longer
   * exists and answered with an error. The transition makes that window visible and closes
   * it; Button derives aria-busy and disabled from `pending` already.
   */
  const [refreshing, startRefresh] = useTransition();

  const fold = (value: string) => (matchCase ? value : value.toLowerCase());
  const confirmed = fold(confirmText.trim()) === fold(confirmToken);

  const submit = (formData: FormData) => {
    startTransition(async () => {
      const result = await action(null, formData);
      if (result.ok) {
        toast({ title: result.message, tone: "success" });
        setOpen(false);
        /*
         * Cleared before the refresh rather than after it. The selection is a set of
         * service ids and most of them are about to stop existing; leaving it in place for
         * the round trip would mean the toolbar counting rows that are already gone.
         */
        onDestroyed?.();
        startRefresh(() => router.refresh());
      } else {
        toast({ title: copy.failedTitle, description: result.error, tone: "error" });
      }
    });
  };

  return (
    <AlertDialogRoot
      open={open}
      /*
       * The typed confirmation is cleared here rather than by unmounting.
       *
       * It used to live in a child that Radix mounted on open and threw away on close, so
       * resetting was a side effect of the split. With the form inlined this state outlives
       * the dialog, and without this line a cancelled confirmation stays typed — reopening
       * would present an already-armed destroy button, which is the one thing this whole
       * component exists to prevent. Cleared in both directions so it cannot depend on how
       * the dialog was dismissed.
       */
      onOpenChange={(next) => {
        setOpen(next);
        setConfirmText("");
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant="danger"
          size="sm"
          disabled={triggerDisabled}
          pending={refreshing}
          pendingLabel={copy.refreshPending}
        >
          <Trash2 aria-hidden />
          {copy.trigger}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        {/* Mounted only while open, which is also what resets the typed confirmation. */}
        {open && (
          <>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy.description}</AlertDialogDescription>

            {/*
              Not `action={submit}`, and on this form that is the difference between
              honouring the checkbox below and overruling it — see ui/form.ts and the rule
              it names. A refused destroy leaves the typed confirmation in place, so the
              button stays armed; with the reset, the second click destroyed with
              `deleteData` back at its default rather than at what the user chose.
            */}
            <form onSubmit={onSubmitWith(submit)} className="mt-4">
              {Object.entries(hiddenFields).flatMap(([name, value]) =>
                (Array.isArray(value) ? value : [value as string]).map((one) => (
                  <input key={`${name}:${one}`} type="hidden" name={name} value={one} />
                )),
              )}

              {extra}

              {/*
                Above the typed confirmation, not below it: this changes what the button on
                the other side of that field is about to do, so it has to be read before the
                field is filled in rather than after.

                Rendered only when there is stored data, so answering it is a decision
                someone made rather than a default they inherited; the action's two toast
                sentences state which way it went either way.
              */}
              {checkbox && (
                <div className="mb-3 space-y-1">
                  <Checkbox
                    name="deleteData"
                    defaultChecked={checkbox.defaultChecked}
                    disabled={pending}
                    label={checkbox.label}
                  />
                  <Text variant="caption" tone="subtle">
                    {checkbox.hint}
                  </Text>
                </div>
              )}

              <Field label={copy.confirmLabel}>
                {(field) => (
                  <Input
                    {...field}
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    placeholder={confirmToken}
                    autoComplete="off"
                  />
                )}
              </Field>

              <PendingStatus
                className="sr-only"
                label={pending ? copy.announce : undefined}
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
                  disabled={!confirmed}
                  pending={pending}
                  pendingLabel={copy.submitPending}
                >
                  {copy.submit}
                </Button>
              </AlertDialogFooter>
            </form>
          </>
        )}
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}
