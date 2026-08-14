"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { LiveRegion } from "./live-region";
import { Text } from "./text";

/** One row. `id` is the identity the caller keys focus and errors on. */
export type KeyValueRow = {
  /**
   * Stable for the row's lifetime, and deliberately not the index — removing row 0 must
   * not re-key every row below it and drag focus along with it.
   */
  id: string;
  name: string;
  value: string;
  /**
   * The name cell is read-only and the row cannot be removed.
   *
   * For a catalog default: dropping the key an image needs to boot is the crash loop the
   * catalog exists to prevent. The value stays fully editable, which is what "override"
   * means here.
   */
  locked?: boolean;
  /**
   * A blank value is filled in server-side.
   *
   * Drives the placeholder and nothing else. This component never holds, renders or
   * receives the resulting value — that is the whole point of representing a generated
   * default as an empty cell rather than as content.
   */
  generatedWhenBlank?: boolean;
};

/** Which cell of which row an error belongs to. */
export type KeyValueError = {
  rowId: string;
  cell: "name" | "value";
  message: string;
};

type KeyValueEditorProps = {
  legend: string;
  description?: string;
  rows: readonly KeyValueRow[];
  onRowsChange: (rows: KeyValueRow[]) => void;

  /** FormData names, parameterised so this is not a spin-up component. */
  nameFieldName: string;
  valueFieldName: string;

  nameLabel: string;
  valueLabel: string;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  /** Shown in a blank value cell the server will fill in. */
  generatedPlaceholder: string;

  addLabel: string;
  /** Resolved by the caller, so the accessible name says what it removes. */
  removeLabel: (row: { name: string; position: number }) => string;
  /** Accessible name for a cell, disambiguated by row — "Variable name 2", not five identical labels. */
  cellLabel: (part: { label: string; position: number }) => string;
  addedAnnouncement: (position: number) => string;
  removedAnnouncement: (row: { name: string; position: number }) => string;

  error?: KeyValueError;

  max: number;
  maxReachedLabel: string;
  disabled?: boolean;
};

/**
 * A list of name/value pairs, submitted as two parallel repeated fields.
 *
 * Lives in `ui/` because it writes appearance — a wrapping row of controls, a danger-toned
 * message, an icon button — which `design-system.md` bans in a feature component. It is
 * domain-free on purpose: it knows rows of two strings, not presets or images, so the
 * edit-an-existing-service path can seed it from a service's own variables.
 *
 * **Why this does not extend `Field`.** `Field` is label + control + one message slot, and
 * that shape is what makes its render-prop id wiring correct: one `useId`, one label, one
 * description. A row here is three controls sharing one message. Generalising `Field` to
 * arrays would push an index into every existing caller's signature to serve this one, so
 * the wiring is done here instead — per cell, which is what a screen reader needs anyway.
 *
 * **The blank-row rule is load-bearing.** A row nobody has typed into carries no `name`
 * attribute on either input, so it is not submitted at all. That is what keeps the trailing
 * blank row out of FormData without the server guessing which indices to skip, and what
 * keeps an error's row index aligned with the rows on screen. Both cells or neither: naming
 * one without the other would desync the two parallel arrays, and the schema would validate
 * one row's key against the next row's value.
 */
export function KeyValueEditor({
  legend,
  description,
  rows,
  onRowsChange,
  nameFieldName,
  valueFieldName,
  nameLabel,
  valueLabel,
  namePlaceholder,
  valuePlaceholder,
  generatedPlaceholder,
  addLabel,
  removeLabel,
  cellLabel,
  addedAnnouncement,
  removedAnnouncement,
  error,
  max,
  maxReachedLabel,
  disabled,
}: KeyValueEditorProps) {
  const base = useId();
  const counter = useRef(0);
  const addRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLFieldSetElement>(null);
  /*
   * Where focus should land after the next commit. A ref rather than state: the node has
   * to exist before it can be focused, so this is read in an effect, and storing it in
   * state would render twice to say something no one renders.
   */
  const pendingFocus = useRef<string | null>(null);
  // State, not a ref: the live region has to re-render for the text to change, and a
  // ref that only happens to be read during the parent's next render is the kind of
  // coupling that stops working the moment rows are memoised.
  const [announcement, setAnnouncement] = useState("");

  const atMax = rows.length >= max;

  const focusIn = (selector: string) => {
    const node = containerRef.current?.querySelector<HTMLElement>(selector);
    node?.focus();
  };

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target === "add") {
      addRef.current?.focus();
      return;
    }
    focusIn(`[data-focus-key="${target}"]`);
    // Primitives only, and deliberately so: `rows` identity changes on every keystroke,
    // and a `t`-like value here is ADR-7's documented duplicate-toast hazard.
  }, [rows.length]);

  /*
   * Destructured before the effect rather than depended on whole.
   *
   * `error` is rebuilt during the caller's render, so its identity changes on every
   * keystroke — depending on the object would re-run this effect continuously and steal
   * focus back to the offending cell while someone was typing in another one. Reading the
   * three primitives is what makes "the same error" actually compare equal, and it is the
   * same hazard ADR-7 documents for `t`.
   */
  const errorRowId = error?.rowId;
  const errorCell = error?.cell;
  const errorMessage = error?.message;

  useEffect(() => {
    if (!errorRowId || !errorCell) return;
    focusIn(`[data-focus-key="${errorRowId}:${errorCell}"]`);
    // errorMessage is a dependency without being read: the same cell failing twice for
    // different reasons is a new thing to be told about, and should move focus again.
  }, [errorRowId, errorCell, errorMessage]);

  const update = (id: string, patch: Partial<KeyValueRow>) => {
    onRowsChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const add = () => {
    if (atMax) return;
    counter.current += 1;
    const id = `${base}-r${counter.current}`;
    setAnnouncement(addedAnnouncement(rows.length + 1));
    pendingFocus.current = `${id}:name`;
    onRowsChange([...rows, { id, name: "", value: "" }]);
  };

  const remove = (row: KeyValueRow, position: number) => {
    const removable = rows.filter((candidate) => !candidate.locked);
    const among = removable.findIndex((candidate) => candidate.id === row.id);
    /*
     * Focus goes to whichever control takes this one's place, in the order a person would
     * expect to find it: the row that moved up into this slot, else the row above, else
     * the only control left.
     */
    const successor = removable[among + 1] ?? removable[among - 1];
    pendingFocus.current = successor ? `${successor.id}:remove` : "add";
    setAnnouncement(removedAnnouncement({ name: row.name, position }));
    onRowsChange(rows.filter((candidate) => candidate.id !== row.id));
  };

  /**
   * Everything about one row that is a decision rather than markup.
   *
   * Computed here rather than inline in the map: the cell discriminants and the message
   * element's id are protocol, and deriving them inside a JSX expression puts identifiers
   * where the i18n rule is looking for copy.
   */
  const describeRow = (row: KeyValueRow, index: number) => {
    const cellError = (cell: "name" | "value") =>
      error && error.rowId === row.id && error.cell === cell
        ? error.message
        : undefined;
    const nameError = cellError("name");
    const valueError = cellError("value");
    return {
      position: index + 1,
      // Both cells or neither — see the blank-row rule in this component's doc comment.
      submits: row.name !== "" || row.value !== "",
      nameError,
      valueError,
      message: nameError ?? valueError,
      messageId: `${row.id}-message`,
      nameKey: `${row.id}:name`,
      valueKey: `${row.id}:value`,
      removeKey: `${row.id}:remove`,
    };
  };

  return (
    <fieldset ref={containerRef} className="flex flex-col gap-2" disabled={disabled}>
      <legend className="text-text text-label font-medium">{legend}</legend>
      {description && (
        <Text variant="caption" tone="subtle">
          {description}
        </Text>
      )}

      {rows.map((row, index) => {
        const {
          position,
          submits,
          nameError,
          valueError,
          message,
          messageId,
          nameKey,
          valueKey,
          removeKey,
        } = describeRow(row, index);

        return (
          <div key={row.id} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 grow basis-40">
                <Input
                  aria-label={cellLabel({ label: nameLabel, position })}
                  data-focus-key={nameKey}
                  name={submits ? nameFieldName : undefined}
                  value={row.name}
                  onChange={(event) => update(row.id, { name: event.target.value })}
                  placeholder={namePlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  readOnly={row.locked}
                  invalid={Boolean(nameError)}
                  aria-describedby={message ? messageId : undefined}
                />
              </div>

              <div className="min-w-0 grow basis-40">
                <Input
                  aria-label={cellLabel({ label: valueLabel, position })}
                  data-focus-key={valueKey}
                  name={submits ? valueFieldName : undefined}
                  value={row.value}
                  onChange={(event) => update(row.id, { value: event.target.value })}
                  placeholder={
                    row.generatedWhenBlank ? generatedPlaceholder : valuePlaceholder
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  invalid={Boolean(valueError)}
                  aria-describedby={message ? messageId : undefined}
                />
              </div>

              {!row.locked && (
                <Button
                  data-focus-key={removeKey}
                  variant="ghost"
                  size="md"
                  aria-label={removeLabel({ name: row.name, position })}
                  onClick={() => remove(row, position)}
                >
                  <X aria-hidden />
                </Button>
              )}
            </div>

            {message && (
              <p id={messageId} role="alert" className="text-caption text-danger">
                {message}
              </p>
            )}
          </div>
        );
      })}

      <div className="flex items-center gap-3">
        <Button
          ref={addRef}
          variant="secondary"
          size="sm"
          onClick={add}
          disabled={atMax}
        >
          <Plus aria-hidden />
          {addLabel}
        </Button>
        {/* Disabled with the reason beside it, rather than hidden: a control that
            vanishes is a control nobody was told about. */}
        {atMax && (
          <Text variant="caption" tone="subtle">
            {maxReachedLabel}
          </Text>
        )}
      </div>

      <LiveRegion className="sr-only">{announcement}</LiveRegion>
    </fieldset>
  );
}
