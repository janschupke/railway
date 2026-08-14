"use client";

import { useId } from "react";
import { Label } from "radix-ui";
import { cn } from "@/lib/utils";

type FieldProps = {
  label: string;
  hint?: string;
  /**
   * Something is wrong with the value and the form will refuse it.
   *
   * Outranks a warning: a field the server is about to reject should say so rather than
   * say something milder about the same value.
   */
  error?: string;
  /**
   * Something is probably wrong with the value, and the form will accept it anyway.
   *
   * Not a weaker error. The distinction is whether submitting is still the right move, and
   * for a warning it is — which is why `invalid` below stays false: no `aria-invalid`, no
   * danger border, nothing that tells a screen reader the value is refused when it is not.
   */
  warning?: string;
  /** Receives the wiring the label and the message need to describe the control. */
  children: (props: {
    id: string;
    "aria-describedby": string | undefined;
    invalid: boolean;
  }) => React.ReactNode;
};

/**
 * Label + control + one message slot.
 *
 * The control is a render prop so the ids actually connect: the label points at the
 * control, and `aria-describedby` points at whichever message is showing. A field that
 * renders its message but never associates it is the most common way a form passes a
 * visual review and fails a screen-reader one.
 *
 * Error replaces warning replaces hint rather than stacking, so there is exactly one
 * description to read. Three rungs on one ladder, not three slots: the alternative — a
 * warning line under a hint line — is two things to read where the field previously had
 * one, on a control whose hint is already the longest on the form.
 */
export function Field({ label, hint, warning, error, children }: FieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? warning ?? hint;

  return (
    <div className="flex flex-col gap-1.5">
      <Label.Root htmlFor={id} className="text-text text-label font-medium">
        {label}
      </Label.Root>

      {children({
        id,
        "aria-describedby": message ? messageId : undefined,
        // Errors only. A warning does not make a value invalid; see the prop's own note.
        invalid: Boolean(error),
      })}

      {message && (
        <p
          id={messageId}
          /*
           * Errors interrupt, warnings wait their turn, hints are static text. `status` is
           * polite on purpose: this one appears while someone is still typing, and an
           * assertive region would talk over them mid-word.
           */
          role={error ? "alert" : warning ? "status" : undefined}
          className={cn(
            "text-caption",
            error ? "text-danger" : warning ? "text-warning" : "text-text-subtle",
          )}
        >
          {message}
        </p>
      )}
    </div>
  );
}
