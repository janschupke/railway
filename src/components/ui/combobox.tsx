"use client";

import { useEffect, useRef, useState } from "react";
import { Popover as Primitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Field } from "./field";
import { byGroup, type GroupedOption } from "./group-options";

export type ComboboxOption = GroupedOption;

type ComboboxProps = {
  label: string;
  hint?: string;
  error?: string;
  /** Non-blocking. Outranks the hint, never sets `aria-invalid` — see Field. */
  warning?: string;
  /** The form field name. This is a real <input>, so the FormData contract is native. */
  name: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  /** Shown inside the popup when the filter matches nothing. Free text stays valid. */
  noMatchesLabel: string;
  /** Names the chevron. Never in the tab order — the input owns the keyboard. */
  toggleLabel: string;
  /** Names the listbox, which is portalled away from its label. */
  listLabel: string;
  inputClassName?: string;
};

/**
 * An editable combobox with list autocomplete (ARIA 1.2).
 *
 * Not a Select, and the difference is the whole point: this field must accept any string
 * the server's own validation accepts, including references that are in no list, and it
 * must let an invalid one through to the server so that one rule stays the single source
 * of truth on what is valid. A Radix Select cannot hold a value that is not an item.
 *
 * Built on Popover.Anchor rather than Popover.Trigger. A Trigger would take
 * `aria-expanded` and `aria-haspopup` for itself, and those belong on the input — it is
 * the combobox, and the popup is its list.
 */
export function Combobox({
  label,
  hint,
  error,
  warning,
  name,
  value,
  onValueChange,
  options,
  placeholder,
  noMatchesLabel,
  toggleLabel,
  listLabel,
  inputClassName,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  /** Index into `filtered`; -1 means nothing is highlighted, which is a real state. */
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /*
   * Filter only once the value has diverged from a known option.
   *
   * Opening the list while the field holds `redis:7-alpine` should show the whole
   * catalog, not the one entry that happens to match it — otherwise picking a preset
   * makes every other preset unreachable without clearing the field first. Typing
   * narrows, as it should.
   */
  const isKnown = options.some((option) => option.value === value);
  const needle = value.trim().toLowerCase();
  const filtered =
    isKnown || !needle
      ? options
      : options.filter(
          (option) =>
            option.value.toLowerCase().includes(needle) ||
            option.label.toLowerCase().includes(needle),
        );

  // Recomputed rather than clamped: the list changes under the highlight as you type.
  const active = highlight >= 0 && highlight < filtered.length ? highlight : -1;

  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const commit = (option: ComboboxOption) => {
    onValueChange(option.value);
    setOpen(false);
    setHighlight(-1);
    inputRef.current?.focus();
  };

  const openWith = (index: number) => {
    setOpen(true);
    setHighlight(index);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        const current = filtered.findIndex((option) => option.value === value);
        openWith(current >= 0 ? current : 0);
        return;
      }
      setHighlight((index) => (index + 1) % Math.max(filtered.length, 1));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openWith(filtered.length - 1);
        return;
      }
      setHighlight(
        (index) =>
          (index - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1),
      );
      return;
    }

    if (event.key === "Enter") {
      // Only intercepted when it would pick something. A closed list means Enter is the
      // form's, and swallowing it would break submitting from the keyboard.
      if (!open || active < 0) return;
      event.preventDefault();
      commit(filtered[active]!);
      return;
    }

    if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      /*
       * stopPropagation because this page has an alertdialog on it: an Escape that closes
       * a dropdown must not also dismiss whatever is behind it. The typed text is left
       * exactly as it is — Escape closes the list, it does not undo the field.
       */
      event.stopPropagation();
      setOpen(false);
      setHighlight(-1);
      return;
    }

    if (event.key === "Tab" && open) {
      setOpen(false);
      setHighlight(-1);
    }
  };

  const listboxId = `${name}-listbox`;

  return (
    <Field
      label={label}
      {...(hint ? { hint } : {})}
      {...(warning ? { warning } : {})}
      {...(error ? { error } : {})}
    >
      {({ id, "aria-describedby": describedBy, invalid }) => (
        <Primitive.Root open={open} onOpenChange={setOpen}>
          <Primitive.Anchor asChild>
            <div className="relative">
              <input
                ref={inputRef}
                id={id}
                name={name}
                value={value}
                onChange={(event) => {
                  onValueChange(event.target.value);
                  setOpen(true);
                  // The list has just changed underneath; nothing is highlighted until
                  // the user says so, so Enter still submits the form.
                  setHighlight(-1);
                }}
                onKeyDown={onKeyDown}
                role="combobox"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-haspopup="listbox"
                aria-autocomplete="list"
                // Omitted, never "": NVDA re-announces the field on an empty value.
                {...(active >= 0
                  ? { "aria-activedescendant": `${id}-o${active}` }
                  : {})}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                autoComplete="off"
                spellCheck={false}
                required
                placeholder={placeholder}
                className={cn(
                  "focus-ring border-border bg-surface text-text text-body",
                  "h-control-md px-control-md w-full rounded-md border pr-9",
                  "placeholder:text-text-subtle",
                  invalid && "border-danger-border",
                  inputClassName,
                )}
              />
              <button
                type="button"
                // Not a tab stop: the input is the control, and a second stop for a
                // shortcut to something ArrowDown already does is noise on the way to
                // the next field.
                tabIndex={-1}
                aria-label={toggleLabel}
                onClick={() => {
                  if (open) {
                    setOpen(false);
                    setHighlight(-1);
                  } else {
                    const current = filtered.findIndex((o) => o.value === value);
                    openWith(current >= 0 ? current : 0);
                  }
                  inputRef.current?.focus();
                }}
                className="focus-ring text-text-subtle hover:text-text absolute inset-y-0 right-0 flex items-center rounded-md px-2.5"
              >
                <ChevronDown aria-hidden className="size-4" />
              </button>
            </div>
          </Primitive.Anchor>

          <Primitive.Portal>
            <Primitive.Content
              align="start"
              sideOffset={4}
              // Focus stays in the input throughout: it is what carries the ARIA state,
              // and a popup that steals focus makes typing-to-filter impossible.
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
              className={cn(
                "border-border bg-raised animate-content z-overlay max-h-64 overflow-y-auto",
                "w-[var(--radix-popover-trigger-width)] rounded-md border p-1 shadow-lg",
              )}
            >
              <div ref={listRef} id={listboxId} role="listbox" aria-label={listLabel}>
                {filtered.length === 0 ? (
                  // Not an option, and not interactive: free text is still valid here,
                  // so this is a note about the list rather than a dead end.
                  <p className="text-text-subtle text-caption px-2 py-1.5">
                    {noMatchesLabel}
                  </p>
                ) : (
                  byGroup(filtered).map(([group, groupOptions]) => {
                    const items = groupOptions.map((option) => {
                      const index = filtered.indexOf(option);
                      return (
                        /*
                         * A real <button>, not a div. The role is `option` either way,
                         * but a button carries the interactivity and the activation
                         * behaviour honestly rather than reimplementing them on a div —
                         * and it is never a tab stop, because in an activedescendant
                         * combobox focus stays on the input by design.
                         */
                        <button
                          key={option.value}
                          type="button"
                          tabIndex={-1}
                          id={`${id}-o${index}`}
                          data-index={index}
                          role="option"
                          aria-selected={option.value === value}
                          // Keeps focus in the input: a mousedown here would blur it and
                          // close the popup before the click ever landed.
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() => commit(option)}
                          onPointerMove={() => setHighlight(index)}
                          className={cn(
                            "text-text text-body flex w-full cursor-pointer items-center justify-between gap-2",
                            "rounded px-2 py-1.5 text-left select-none",
                            index === active && "bg-highlight",
                            option.value === value && "text-accent",
                          )}
                        >
                          <span className="truncate">{option.label}</span>
                          <span className="text-text-subtle text-mono truncate font-mono">
                            {option.value}
                          </span>
                          {option.value === value && (
                            <Check aria-hidden className="size-3.5 shrink-0" />
                          )}
                        </button>
                      );
                    });

                    if (group === null) return items;

                    return (
                      <div key={group} role="group" aria-label={group}>
                        {/*
                          presentation, not option: an unnamed non-option child of a
                          listbox is otherwise announced as one of the items.
                        */}
                        <p
                          role="presentation"
                          className="text-text-subtle text-caption px-2 py-1"
                        >
                          {group}
                        </p>
                        {items}
                      </div>
                    );
                  })
                )}
              </div>
            </Primitive.Content>
          </Primitive.Portal>
        </Primitive.Root>
      )}
    </Field>
  );
}
