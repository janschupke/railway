"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ActionResult, ActionSelection } from "@/lib/action-result";
import { Button } from "./ui/button";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { PendingStatus } from "./ui/misc";
import { useToast } from "./ui/toast";

/**
 * One dialog, both create paths.
 *
 * Projects and environments differ in exactly two ways — the copy, and whether a hidden
 * `projectId` rides along — so they are one component parameterised rather than two files
 * that would drift. The `field` prop is both the form field name and the `ActionField`
 * the action attributes an error to, which is what keeps a rename from silently sending
 * a server error to the toast instead of the input.
 *
 * Deliberately NOT a `next/dynamic` import at its call sites: doing that to the destroy
 * dialog put nothing in the content at open time and broke Radix's focus trap, which
 * e2e/keyboard.spec.ts caught. See destroy-container-dialog.tsx.
 */
export function CreateNameDialog({
  action,
  field,
  hidden,
  copy,
  triggerVariant = "secondary",
  disabled,
  onCreated,
  open: openProp,
  onOpenChange,
}: {
  action: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  /** The form input's name, and the field the action attributes an error to. */
  field: "projectName" | "environmentName";
  /** Extra values the action needs that the user does not type. */
  hidden?: Record<string, string>;
  copy: {
    trigger: string;
    title: string;
    description: string;
    label: string;
    placeholder: string;
    submit: string;
    submitPending: string;
    announce: string;
    failedTitle: string;
  };
  triggerVariant?: "primary" | "secondary";
  disabled?: boolean;
  onCreated: (select: ActionSelection | undefined) => void;
  /**
   * Controlled open. Supplied, this renders NO trigger of its own — the caller owns the
   * affordance, which is what lets the pickers put "New project" inside their dropdown
   * rather than beside it.
   *
   * Left out, everything below behaves exactly as it did: the dialog holds its own state
   * and draws its own button. That is what keeps the empty-state call site — where
   * creating a project is the whole point of the screen and the button is a primary
   * invitation — working unchanged.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const tCommon = useTranslations("common");
  const { toast } = useToast();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [error, setError] = useState<string | undefined>(undefined);
  /*
   * Controlled, unlike the spin-up form's name field, and not a stylistic difference.
   * React resets an uncontrolled `<form action={fn}>` once the action settles — which on
   * the failure path threw away what the person had just typed and left them retyping a
   * name to fix a length error about it. The value has to outlive the submit, so it lives
   * in state rather than in the DOM.
   */
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();

  /*
   * The action is awaited inside a transition rather than driven by useActionState, for
   * the reason destroy-container-form.tsx gives: the dialog has to close on success, and
   * reacting to a result in an effect means calling setState from an effect body.
   */
  const submit = (formData: FormData) => {
    startTransition(async () => {
      const result = await action(null, formData);
      if (result.ok) {
        setError(undefined);
        setOpen(false);
        /*
         * Toasted here rather than by the caller. Both call sites want the same thing and
         * neither adds anything to the sentence, and the toast has to outlive the dialog
         * that is closing on the line above — which is exactly what a toast is for.
         */
        toast({ title: result.message, tone: "success" });
        onCreated(result.select);
        return;
      }
      /*
       * Attributed errors render against the input and leave the dialog open with what
       * was typed still in it. Anything else is not about the field — a refused token, a
       * rate limit, a project id the picker filled in — and belongs in a toast, where it
       * is still readable once the user gives up and closes the dialog.
       */
      if (result.field === field) setError(result.error);
      else {
        setError(undefined);
        toast({
          title: copy.failedTitle,
          description: result.error,
          tone: "error",
        });
      }
    });
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A dismissed dialog must not reopen holding the last attempt's error or its name.
        if (!next) {
          setError(undefined);
          setValue("");
        }
      }}
    >
      {/* Controlled means somebody else is the affordance; two would be one too many. */}
      {!controlled && (
        <DialogTrigger asChild>
          <Button variant={triggerVariant} size="sm" disabled={disabled}>
            <Plus aria-hidden />
            {copy.trigger}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent closeLabel={tCommon("close")}>
        {/* Mounted only while open, so the trigger is what builds the form each time. */}
        {open && (
          <>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>

            <form action={submit} className="mt-4">
              {Object.entries(hidden ?? {}).map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}

              <Field label={copy.label} error={error}>
                {(control) => (
                  <Input
                    {...control}
                    name={field}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={copy.placeholder}
                    autoComplete="off"
                    required
                  />
                )}
              </Field>

              {/* The button's own label change is not announced; this is. */}
              <PendingStatus
                className="sr-only"
                label={pending ? copy.announce : undefined}
              />

              <DialogFooter>
                <DialogClose asChild>
                  {/* Dismissing mid-flight unmounts the form and strands the request. */}
                  <Button variant="ghost" disabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  variant="primary"
                  pending={pending}
                  pendingLabel={copy.submitPending}
                >
                  {copy.submit}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
