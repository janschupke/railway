/**
 * Turning a Server Action's error back into a cell of the variable editor.
 *
 * Both forms that own variable rows — spin-up and edit — worked this out for themselves,
 * with the same filter, the same index lookup and the same explanation of why the index
 * counts over submitted rows rather than over rows on screen, written twice. The second
 * copy even said "same rule as spin-up", which is a comment doing a module's job.
 *
 * The rule it encodes is easy to get wrong in a way nothing would catch: a blank row
 * carries no `name` attribute and never reaches FormData at all, so zod's index counts
 * over a *shorter* list than the one being rendered. Counting over the rendered rows
 * instead puts the error on whichever row happens to sit at that position, which looks
 * like a correct error against the wrong variable.
 *
 * Kept free of the editor's own types on purpose. This is the unit tier — pure, node, no
 * jsdom — and taking the smallest row shape that carries the answer is what lets it stay
 * there instead of importing a client component to describe its argument.
 */

import type { ActionResult } from "./action-result";

/** The part of a row this needs: enough to submit it, and enough to name it afterwards. */
export type SubmittableRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
};

/** Which cell of a row an error belongs against. */
export type RowError = {
  readonly rowId: string;
  readonly cell: "name" | "value";
  readonly message: string;
};

/** The two `ActionField`s that name a variable rather than a single-instance input. */
export const isVariableField = (field: string | undefined): boolean =>
  field === "variableKey" || field === "variableValue";

/**
 * The rows that actually reach FormData, in the order they reach it.
 *
 * Exported because it is the definition the index is counted against; a caller that wants
 * to assert something about submission is asking about this list, not about `rows`.
 */
export const submittedRows = <Row extends SubmittableRow>(
  rows: readonly Row[],
): Row[] => rows.filter((row) => row.name !== "" || row.value !== "");

/**
 * Where to draw this result's error inside the editor, if it belongs to a row at all.
 *
 * `undefined` covers every case that is not a per-row variable error: success, a
 * single-instance field, and a rule about the whole list — which has no row to point at
 * and is `isUnattributable`'s business instead.
 */
export function rowErrorFor(
  result: ActionResult | null | undefined,
  rows: readonly SubmittableRow[],
): RowError | undefined {
  if (!result || result.ok) return undefined;
  if (!isVariableField(result.field) || result.index === undefined) return undefined;

  return {
    rowId: submittedRows(rows)[result.index]?.id ?? "",
    cell: result.field === "variableKey" ? "name" : "value",
    message: result.error,
  };
}

/**
 * Whether this failure has nowhere on the form to render itself, and so has to be a toast.
 *
 * Two shapes qualify: an error attributed to no field at all, and a variable error with no
 * row index — "too many rows", "too large together", rules about the set rather than a
 * member of it. Everything else renders inline beside its input, and toasting it as well
 * would say the same thing twice.
 */
export function isUnattributable(result: ActionResult): boolean {
  if (result.ok) return false;
  if (!result.field) return true;
  return isVariableField(result.field) && result.index === undefined;
}
