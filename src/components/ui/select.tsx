"use client";

import { useId, useState } from "react";
import { Select as Primitive } from "radix-ui";
import { Check, ChevronDown, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Field } from "./field";
import { byGroup, type GroupedOption } from "./group-options";

type SelectOption = GroupedOption;

/**
 * Stands in for the empty string, which Radix refuses.
 *
 * `<Select.Item value="">` throws at runtime, and blank is the resting state of both
 * advanced controls — it is how a person says "let Railway decide" and, crucially, how
 * they say it *again* after picking Frankfurt. So the empty option has to be a real row.
 *
 * NUL-prefixed so a collision is impossible rather than merely unobserved: Railway ids,
 * the region pattern and the restart policies are all printable, and none of these values
 * reaches a URL. Written as an escape and not as a literal NUL, which would make this file
 * binary to git and grep.
 *
 * It is mapped in three places, all inside this file — the Root's value, the Item's value,
 * and the Root's onValueChange. The hidden input below is deliberately not one of them.
 */
const EMPTY_VALUE = "\u0000empty";

/**
 * The trailing action row's value, for the same reason and with the same guarantee.
 *
 * A row that opens a create dialog is not a choice among the options, so it must never
 * reach `onValueChange` — a caller writing a project id into the URL would be handed a
 * value that is not one. The row suppresses Radix's own selection instead of relying on
 * the caller to filter this out; the constant exists because a `Primitive.Item` still
 * needs a value, and this one can never collide with a real option.
 */
const ACTION_VALUE = "\u0000action";

/**
 * Styled single-select on Radix, and the app's only one.
 *
 * There used to be a second export here — a `NativeSelect` wrapping a real `<select>`,
 * used by the two controls behind the spin-up form's advanced disclosure — with a docblock
 * arguing the split on three counts. Two dropdowns that look nothing alike in one app is
 * what a design system exists to prevent, so the three objections were answered instead of
 * restated:
 *
 *   - **An empty option** is `EMPTY_VALUE` above. The objection was that a sentinel becomes
 *     "a magic value in the schema, the action and the e2e fixture" — it does not, because
 *     the hidden input that submits is rendered from the caller's `value` rather than from
 *     Radix's state, so no code outside this file is ever handed one.
 *
 *     Note the narrower claim: the sentinel is not invisible, it is unsubmittable. Radix
 *     mirrors its own value into an aria-hidden `<select>` whenever the trigger sits inside
 *     a form, so it genuinely appears in the DOM — that control is unnamed and therefore
 *     contributes nothing to `FormData`. `primitives.test.tsx` asserts the submission, not
 *     the markup, which is the property that is actually true.
 *   - **An error** is the `error` prop, forwarded to `Field` exactly as the native one did.
 *   - **Groups** are a portal and a popper per control rather than one `<optgroup>`. That
 *     cost is real and was accepted: Radix Select is already in this route's graph for the
 *     project picker and the filter bar, so the second and third instance add no module.
 *
 * What was genuinely lost is the platform's own typeahead, replaced by Radix's — along
 * with Home/End and arrow-key navigation, which `e2e/keyboard.spec.ts` covers because an
 * axe pass alone would not prove any of it.
 */
export function Select({
  label,
  value,
  options,
  onValueChange,
  name,
  hint,
  error,
  disabled,
  disabledReason,
  placeholder,
  inline,
  action,
  triggerRef,
}: {
  /** Rendered as a visible <label>, associated with the trigger — or, inline, inside it. */
  label: string;
  /**
   * The chosen value. `undefined` shows the placeholder; `""` selects the empty option,
   * which is a different thing and a state the caller can return to.
   */
  value: string | undefined;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  /**
   * Submits under this name, through a hidden input this component owns.
   *
   * Deliberately NOT Radix's own `name` prop. Radix renders a hidden native <select> of
   * its own whenever the trigger sits inside a form, and writes its internal value to it
   * verbatim — which is `EMPTY_VALUE`. That control stays unnamed here, so it contributes
   * nothing to `FormData`; do not "simplify" this by handing the name to Radix.
   */
  name?: string;
  /** Static help under the control. Ignored inline, which has no under. */
  hint?: string;
  /**
   * The form will refuse this value. `Field` supplies `aria-invalid` and a `role="alert"`
   * message; the trigger takes the danger border.
   *
   * Nothing wires this today: `region` and `restartPolicy` are not members of
   * `ActionField`, so their server errors reach the user as a toast. It exists because the
   * control it replaced had it, and a primitive that can only be used correctly by
   * knowing which fields are attributable is the wrong shape.
   */
  error?: string;
  disabled?: boolean;
  /**
   * Why this control cannot be used, shown under it.
   *
   * A dimmed trigger states that something is unavailable and nothing about why, and an
   * enabled one that opens an empty list is worse — it reads as a broken control rather
   * than an empty one. Required whenever a caller can produce either state.
   */
  disabledReason?: string;
  placeholder?: string;
  /**
   * Drop the label block and put the label inside the trigger, ahead of the value.
   *
   * For a control that belongs on a row of controls rather than in a form. A `Field` puts
   * its label on a line of its own, which is right above an input in a column and wrong
   * beside one in a strip — the filter bar's height is a decision that file argues for, and
   * a two-line control in it would be the thing that breaks it.
   *
   * The label stays *visible*, as static text in the trigger, so the accessible name is
   * "Sort Newest first" and satisfies Label in Name (WCAG 2.5.3) by construction — there is
   * no `aria-label` here that could drift from what is on screen, which is the failure the
   * MultiSelect trigger next to this one has to write a catalog string to avoid.
   */
  inline?: boolean;
  /**
   * A row at the end of the list that does something instead of choosing something.
   *
   * "New project" belongs in the control it adds to rather than beside it: the reader is
   * already looking at the list of projects when they find out theirs is not in it.
   *
   * `onSelect` runs after the popup has fully closed — see the sequencing note below —
   * and `onValueChange` is never called for it.
   */
  action?: { label: string; onSelect: () => void };
  /**
   * The trigger element, for a caller that has to put focus back on it.
   *
   * Needed only alongside `action`, and it is not optional there in practice. The row opens
   * a dialog this component does not own, and Radix restores focus to a `DialogTrigger` —
   * of which a controlled dialog renders none, so focus lands on `<body>` when it closes.
   * The caller is the only thing that knows when that happened.
   */
  triggerRef?: React.Ref<HTMLButtonElement>;
}) {
  const t = useTranslations("common");
  const inlineId = useId();
  /*
   * Open state is owned here only because the action row needs it: selecting that row
   * suppresses Radix's own selection, which is also what would have closed the popup, so
   * it has to be closed deliberately.
   */
  const [open, setOpen] = useState(false);

  /*
   * A popup with nothing in it is a dead end, whatever the caller passed — but a popup
   * whose one row is the thing that fixes the emptiness is a choice. That is the case an
   * environment picker is in for a project with no environments yet.
   */
  const empty = options.length === 0 && !action;
  const inert = Boolean(disabled) || empty;
  const reason = inert ? disabledReason : undefined;

  /**
   * Closes the popup, then runs the action one frame later.
   *
   * The delay is the whole reason this is not three lines in a click handler. A Select
   * popup is a modal layer: it holds a scroll lock, puts `aria-hidden` on every sibling of
   * its portal, sets `pointer-events: none` on the body, and restores focus to the
   * trigger. All of that unwinds in the commit that `setOpen(false)` schedules — which
   * React flushes at the end of this discrete event, so by the time the frame callback
   * runs the layer is genuinely gone. Opening a Dialog any sooner is two modal layers
   * racing each other's teardown: it mounts under a body that still refuses pointer
   * events, and the select's focus restore pulls focus straight back out of it.
   *
   * Note what is deliberately NOT done: `onCloseAutoFocus` is left alone. Letting the
   * restore run means the trigger is `document.activeElement` when the dialog mounts, so
   * the dialog's own focus scope records it and returns focus there on close — for free,
   * with no `returnFocus` prop threaded through two components.
   *
   * Closing here rather than through Radix, because the row suppresses `handleSelect` —
   * which is also what would have closed it.
   */
  const requestAction = () => {
    if (!action) return;
    setOpen(false);
    requestAnimationFrame(action.onSelect);
  };

  const control = (
    props: {
      id?: string;
      "aria-describedby"?: string | undefined;
      invalid?: boolean;
    } = {},
  ) => {
    const { invalid, ...triggerProps } = props;

    return (
      <Primitive.Root
        // The sentinel is applied here and unwound below, and nowhere else.
        value={value === "" ? EMPTY_VALUE : value}
        onValueChange={(next) => onValueChange(next === EMPTY_VALUE ? "" : next)}
        disabled={inert}
        open={open}
        onOpenChange={setOpen}
      >
        {/*
          Rendered from `value`, never from Radix's internal state — which is the whole
          reason the sentinel cannot escape. There is no code path where this element
          holds anything the caller did not pass in.

          `disabled` reproduces the native rule exactly: a disabled control is skipped by
          the form-data construction algorithm, which is what keeps a region out of the
          submission when Railway offered no region list to choose from.
        */}
        {name && (
          <input type="hidden" name={name} value={value ?? ""} disabled={inert} />
        )}

        <Primitive.Trigger
          {...triggerProps}
          ref={triggerRef}
          aria-invalid={invalid || undefined}
          /*
           * `combobox` takes its name from the author, never from its contents — which is
           * the one thing that made the obvious inline spelling wrong: a trigger reading
           * "Sort Newest first" on screen computed an accessible name of "" and the control
           * was announced as an unnamed combobox.
           *
           * Pointed at the two spans rather than given an `aria-label`, so the name IS the
           * visible text rather than a second copy of it that a later edit could contradict.
           * Label in Name (WCAG 2.5.3) then holds by construction, and it moves with the
           * selection for free.
           */
          {...(inline
            ? { "aria-labelledby": `${inlineId}-label ${inlineId}-value` }
            : {})}
          /*
           * `w-full`, not `inline-flex`. A content-sized trigger resizes as the
           * selection changes, so the row shuffled under the cursor every time someone
           * picked a project with a longer name. Filling the slot is this component's
           * business; how wide the slot is belongs to the caller, which is why there is
           * still no className prop here.
           *
           * Inline it takes a fixed width instead, for the same reason said the other way
           * round: there is no slot to fill on a wrapping strip, and a trigger sized to
           * "Name A–Z" one moment and "Created here first" the next would move every
           * control after it each time the reader chose one.
           */
          className={cn(
            "focus-ring border-border bg-surface text-text flex items-center justify-between gap-2",
            "text-body h-control-md px-control-md rounded-md border",
            "hover:bg-subtle data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
            inline ? "w-56 shrink-0" : "w-full",
            invalid && "border-danger-border",
          )}
        >
          {/* The visible label, inline only. Static text rather than a placeholder: it
                  is there whatever is selected, which is what makes it part of the name. */}
          {inline && (
            <span id={`${inlineId}-label`} className="text-text-subtle shrink-0">
              {label}
            </span>
          )}
          {/* truncate + shrink-0, so a long project name cannot squeeze out the
                  affordance that says this is a menu. */}
          <span id={inline ? `${inlineId}-value` : undefined} className="truncate">
            <Primitive.Value placeholder={placeholder ?? t("selectPlaceholder")} />
          </span>
          <Primitive.Icon>
            <ChevronDown aria-hidden className="text-text-subtle size-4 shrink-0" />
          </Primitive.Icon>
        </Primitive.Trigger>

        <Primitive.Portal>
          <Primitive.Content
            position="popper"
            sideOffset={4}
            className={cn(
              "border-border bg-raised z-overlay max-h-64 min-w-[var(--radix-select-trigger-width)]",
              "overflow-hidden rounded-md border shadow-lg",
              /*
               * Enter only, for the reason tooltip.tsx gives: Presence keeps a closing
               * node mounted for as long as an animation runs on it, and this one is a
               * modal layer — it holds a scroll lock and `aria-hidden` on the rest of
               * the document while it lives. A dismissed dropdown is a user getting
               * back to work, so it goes at once; the dialog and the toast, which
               * announce and confirm, animate both ways.
               */
              "animate-content-enter",
            )}
          >
            <Primitive.Viewport className="p-1">
              {byGroup(options).map(([group, groupOptions]) => {
                const items = groupOptions.map((option) => (
                  <Primitive.Item
                    key={option.value}
                    value={option.value === "" ? EMPTY_VALUE : option.value}
                    className={cn(
                      "text-text flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5",
                      "text-body outline-none select-none",
                      "data-[highlighted]:bg-highlight data-[state=checked]:text-accent",
                    )}
                  >
                    <Primitive.ItemText>{option.label}</Primitive.ItemText>
                    <Primitive.ItemIndicator>
                      <Check aria-hidden className="size-3.5" />
                    </Primitive.ItemIndicator>
                  </Primitive.Item>
                ));

                // Ungrouped options are not wrapped: an unlabelled Group would still
                // announce itself to a screen reader as a group with no name.
                if (group === null) return items;

                return (
                  <Primitive.Group key={group}>
                    <Primitive.Label className="text-text-subtle text-caption px-2 py-1">
                      {group}
                    </Primitive.Label>
                    {items}
                  </Primitive.Group>
                );
              })}

              {action && (
                <>
                  {options.length > 0 && (
                    <Primitive.Separator className="bg-border -mx-1 my-1 h-px" />
                  )}
                  {/*
                    A `Primitive.Item` rather than a bare button, and the three
                    `preventDefault`s are the price of it.

                    Radix runs an Item's own handlers ahead of its internal `handleSelect`
                    and skips that entirely when the first one calls `preventDefault` —
                    which is the mechanism: this row never reaches the caller's
                    `onValueChange`. It has to close the popup itself in exchange.

                    A plain button would have avoided all three and cost more: outside
                    Radix's collection it is unreachable by ArrowDown, holds no roving
                    tabindex, and — since `SelectItem` builds its accessible name from
                    `ItemText` — would have had no name at all.
                  */}
                  <Primitive.Item
                    value={ACTION_VALUE}
                    className={cn(
                      "text-accent flex cursor-pointer items-center gap-2 rounded px-2 py-1.5",
                      "text-body outline-none select-none",
                      "data-[highlighted]:bg-highlight",
                    )}
                    onPointerUp={(event) => {
                      event.preventDefault();
                      requestAction();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      requestAction();
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      // Also stops Space scrolling the page behind the popup.
                      event.preventDefault();
                      requestAction();
                    }}
                  >
                    <Plus aria-hidden className="size-3.5 shrink-0" />
                    <Primitive.ItemText>{action.label}</Primitive.ItemText>
                  </Primitive.Item>
                </>
              )}
            </Primitive.Viewport>
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    );
  };

  /*
   * Inline skips `Field` entirely rather than hiding its label.
   *
   * An `sr-only` label would leave the control announced twice — once from the label, once
   * from the text now inside the trigger — and would still render the wrapper's column
   * layout, which is the thing the row cannot have. There is nothing left for the hint
   * either: `disabledReason` and `hint` exist to explain a control in the space under it,
   * and a strip has no under.
   */
  if (inline) return control();

  return (
    <Field
      label={label}
      // A dead control explains itself first; otherwise the static hint stands.
      {...(reason ? { hint: reason } : hint ? { hint } : {})}
      {...(error ? { error } : {})}
    >
      {({ id, "aria-describedby": describedBy, invalid }) =>
        control({ id, "aria-describedby": describedBy, invalid })
      }
    </Field>
  );
}
