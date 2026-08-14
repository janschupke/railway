"use client";

import { useId } from "react";
import { Select as Primitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Field } from "./field";
import { byGroup, type GroupedOption } from "./group-options";

type SelectOption = GroupedOption;

/**
 * A single-select that reaches `FormData`, on the platform's own `<select>`.
 *
 * Two selects in one file is a real asymmetry and it is worth stating rather than leaving
 * for someone to find. The Radix one below earns its bytes on the project picker: a control
 * everyone uses, on every visit, that never submits anything — its value goes into the URL.
 * This one is for controls behind a disclosure that must submit and must be able to say
 * "nothing chosen", and it wins on three counts that are not about size:
 *
 *   - **An empty option.** `<Select.Item value="">` throws at runtime in Radix, and blank is
 *     the default and most common state of both controls that use this — it is how a person
 *     says "let Railway decide". Working around it means a sentinel string mapped back on the
 *     server, which is a magic value in the schema, the action and the e2e fixture.
 *   - **An error.** `Field` gives this one `aria-invalid` and a `role="alert"` message
 *     through the render prop, for free. The Radix wrapper takes no `error` prop, and adding
 *     one is a change to the component the project picker depends on.
 *   - **Groups.** `<optgroup>` is one element. Radix needs a portal, a popper and a Presence
 *     per control to draw the same headings.
 *
 * What is genuinely lost is Radix's typeahead and Home/End, which is what the swap below was
 * made for. A native select has its own typeahead in every browser; what it does not have is
 * the styling, and these controls are inside a panel most people never open.
 */
export function NativeSelect({
  label,
  hint,
  error,
  options,
  disabledReason,
  ...props
}: React.ComponentProps<"select"> & {
  label: string;
  hint?: string;
  error?: string;
  options: SelectOption[];
  /** Why the control cannot be used, on the terms the Radix Select states below. */
  disabledReason?: string;
}) {
  // Nothing to choose is a disabled control, whatever the caller passed — the Radix one's
  // rule, and for its reason: an enabled select with one blank row is not a choice.
  const empty = options.length === 0;
  const inert = Boolean(props.disabled) || empty;

  return (
    <Field
      label={label}
      {...(inert && disabledReason ? { hint: disabledReason } : hint ? { hint } : {})}
      {...(error ? { error } : {})}
    >
      {({ id, "aria-describedby": describedBy, invalid }) => (
        <select
          {...props}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          disabled={inert}
          className={cn(
            "focus-ring border-border bg-surface text-text w-full",
            "text-body h-control-md px-control-md rounded-md border",
            "disabled:cursor-not-allowed disabled:opacity-50",
            invalid && "border-danger-border",
          )}
        >
          {byGroup(options).map(([group, groupOptions]) => {
            const items = groupOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ));
            // Ungrouped options are not wrapped, for the Radix one's reason: an unlabelled
            // group is a group a screen reader announces with no name.
            if (group === null) return items;
            return (
              <optgroup key={group} label={group}>
                {items}
              </optgroup>
            );
          })}
        </select>
      )}
    </Field>
  );
}

/**
 * Styled single-select on Radix.
 *
 * A native <select> is the more accessible default and was what this replaced; Radix
 * earns the swap by being stylable from the design tokens while keeping typeahead,
 * arrow-key navigation, Home/End and Escape. Those are covered by e2e/keyboard.spec.ts —
 * an axe pass alone would not prove any of it.
 */
export function Select({
  label,
  value,
  options,
  onValueChange,
  disabled,
  disabledReason,
  placeholder,
  inline,
}: {
  /** Rendered as a visible <label>, associated with the trigger — or, inline, inside it. */
  label: string;
  value: string | undefined;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
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
   * Why this control cannot be used, shown under it.
   *
   * A dimmed trigger states that something is unavailable and nothing about why, and an
   * enabled one that opens an empty list is worse — it reads as a broken control rather
   * than an empty one. Required whenever a caller can produce either state.
   */
  disabledReason?: string;
  placeholder?: string;
}) {
  const t = useTranslations("common");
  const inlineId = useId();

  // Nothing to choose is a disabled control by definition, whatever the caller passed:
  // an open popup with no items in it is not a choice, it is a dead end.
  const empty = options.length === 0;
  const inert = Boolean(disabled) || empty;
  const reason = inert ? disabledReason : undefined;

  const control = (
    props: { id?: string; "aria-describedby"?: string | undefined } = {},
  ) => (
    <Primitive.Root value={value} onValueChange={onValueChange} disabled={inert}>
      <Primitive.Trigger
        {...props}
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
                  value={option.value}
                  className={cn(
                    "text-text flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5",
                    "text-body outline-none select-none",
                    "data-[highlighted]:bg-subtle data-[state=checked]:text-accent",
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
          </Primitive.Viewport>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );

  /*
   * Inline skips `Field` entirely rather than hiding its label.
   *
   * An `sr-only` label would leave the control announced twice — once from the label, once
   * from the text now inside the trigger — and would still render the wrapper's column
   * layout, which is the thing the row cannot have. There is nothing left for the hint
   * either: `disabledReason` exists to explain a dead control under it, and a strip has no
   * under.
   */
  if (inline) return control();

  return (
    <Field label={label} {...(reason ? { hint: reason } : {})}>
      {({ id, "aria-describedby": describedBy }) =>
        control({ id, "aria-describedby": describedBy })
      }
    </Field>
  );
}
