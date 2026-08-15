import type { FormEvent } from "react";

/**
 * Submit handling for a form whose action is called by hand.
 *
 * Every form in this app already ran its action inside a transition of its own — the
 * `action` prop was only ever building the FormData — and that prop costs more than it
 * gives: React resets the form once the action settles, which silently reverts a Radix
 * Select, an uncontrolled checkbox and an uncontrolled input while leaving controlled text
 * fields exactly as they were. `local/no-function-form-action` is where that mechanism is
 * written down and what keeps the prop from coming back.
 *
 * A function rather than three lines per form, because it was three identical lines in five
 * places and the fourth copy is where one of them would have quietly built the FormData
 * somewhere else. Which brings up the one ordering rule worth stating:
 *
 * **`new FormData` runs before `submit` does.** Several forms disable a control while the
 * submission is in flight, and a disabled control is skipped by the form-data algorithm —
 * so building the FormData inside the transition, after the re-render, would drop exactly
 * the fields that are interesting. Here it is an argument, evaluated first, which is the
 * property to preserve if this is ever inlined again.
 */
export const onSubmitWith =
  (submit: (formData: FormData) => void) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit(new FormData(event.currentTarget));
  };
