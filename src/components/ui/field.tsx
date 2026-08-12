"use client";

import { useId } from "react";
import { Label } from "radix-ui";
import { cn } from "@/lib/utils";

type FieldProps = {
  label: string;
  hint?: string;
  error?: string;
  /** Receives the wiring the label, hint and error need to describe the control. */
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
 * control, and `aria-describedby` points at whichever of hint/error is showing. A field
 * that renders its message but never associates it is the most common way a form passes
 * a visual review and fails a screen-reader one.
 *
 * Error replaces hint rather than stacking, so there is exactly one description to read.
 */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-1.5">
      <Label.Root htmlFor={id} className="text-text text-sm font-medium">
        {label}
      </Label.Root>

      {children({
        id,
        "aria-describedby": message ? messageId : undefined,
        invalid: Boolean(error),
      })}

      {message && (
        <p
          id={messageId}
          // Errors are announced when they appear; hints are static text.
          role={error ? "alert" : undefined}
          className={cn("text-xs", error ? "text-danger" : "text-text-subtle")}
        >
          {message}
        </p>
      )}
    </div>
  );
}
