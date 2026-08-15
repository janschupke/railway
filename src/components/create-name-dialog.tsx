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
import { onSubmitWith } from "./ui/form";
import type { GroupedOption } from "./ui/group-options";
import { Input } from "./ui/input";
import { PendingStatus } from "./ui/misc";
import { Select } from "./ui/select";
import { useToast } from "./ui/toast";

/**
 * Every string this dialog renders.
 *
 * Named rather than inline so `copyFor` in create-dialogs.tsx can build one from a
 * namespace: both callers resolve the same nine keys and differed only in which namespace
 * they read them from, which was nine lines written twice.
 */
export type CreateNameCopy = {
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

/**
 * A second control the dialog submits, for a value chosen rather than typed.
 *
 * One caller — the workspace a project is created in — and named for the shape rather than
 * for that, because the dialog itself has no business knowing what a workspace is.
 *
 * Deliberately NOT `hidden`, which reads like a fit until its last five words: those are
 * "extra values the action needs that the user does not type", and this is one the user
 * does choose. And deliberately not an `error` member either — see the routing rule in
 * `submit` below and the note on `ACTION_FIELDS` in lib/action-result.ts.
 */
export type CreateNameChoice = {
  /**
   * Submits under this name, and a literal for the reason `field` is one: a free `string`
   * here would let a rename separate the control from the value the action reads.
   */
  name: "workspaceId";
  label: string;
  /**
   * Empty makes the control inert, which is what draws `disabledReason` under it — see
   * `Select`. That is the whole handling of "there is nothing to choose from and the
   * reader is owed a sentence about why".
   */
  options: GroupedOption[];
  disabledReason?: string;
};

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
  choice,
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
  /** A second control, for a value the user chooses rather than types. */
  choice?: CreateNameChoice;
  copy: CreateNameCopy;
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
   * Controlled, which is now belt as well as braces: the form no longer resets itself, so
   * an uncontrolled input here would survive a refusal too. It stays in state because the
   * dialog decides when this field is empty — see the reset on close below, which has no
   * DOM equivalent for a value the caller never sees.
   */
  const [value, setValue] = useState("");
  /*
   * Held here rather than by the caller, for the reason above and one more. The reset below
   * is the only code that knows the dialog closed: at the empty-state call site the dialog
   * is uncontrolled, so the caller is never told. A `children` slot would hand the caller
   * state it has no way to clear, and a create that quietly reused the last attempt's
   * choice is exactly the silence this whole feature exists to remove.
   *
   * Blank is the resting state, and what it means belongs to the caller — here it is only
   * "the option the control opens on".
   */
  const [chosen, setChosen] = useState("");
  const [pending, startTransition] = useTransition();

  /*
   * The action is awaited inside a transition rather than driven by useActionState, for
   * the reason confirm-destroy-dialog.tsx gives: the dialog has to close on success, and
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
        // A dismissed dialog must not reopen holding the last attempt's error, its name or
        // the destination that was picked for it.
        if (!next) {
          setError(undefined);
          setValue("");
          setChosen("");
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

            {/*
              `onSubmit` rather than `action`, which is what keeps the choice below from
              reverting to the personal account on a refused name — see ui/form.ts and the
              rule it names for why no form here takes a function action.
            */}
            <form onSubmit={onSubmitWith(submit)} className="mt-4">
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

              {/*
                After the name, because the name is what the reader came to type and this
                qualifies it. `Select` owns the hidden input that submits — its own `name`
                prop — so nothing here reaches `FormData` twice.
              */}
              {choice && (
                <div className="mt-4">
                  <Select
                    name={choice.name}
                    label={choice.label}
                    value={chosen}
                    options={choice.options}
                    onValueChange={setChosen}
                    {...(choice.disabledReason
                      ? { disabledReason: choice.disabledReason }
                      : {})}
                  />
                </div>
              )}

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
