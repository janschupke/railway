import { describe, expect, it } from "vitest";

import type { ActionResult } from "./action-result";
import {
  isUnattributable,
  isVariableField,
  rowErrorFor,
  submittedRows,
} from "./variable-rows";

const row = (id: string, name: string, value: string) => ({ id, name, value });

/** Two blank rows around a filled one, which is the arrangement the index rule is for. */
const ROWS = [
  row("blank-first", "", ""),
  row("a", "TOKEN", "abc"),
  row("blank-middle", "", ""),
  row("b", "OTHER", ""),
];

const refused = (
  over: Partial<Extract<ActionResult, { ok: false }>>,
): ActionResult => ({
  ok: false,
  error: "Refused",
  ...over,
});

describe("submittedRows", () => {
  it("keeps a row with either cell filled and drops a wholly blank one", () => {
    expect(submittedRows(ROWS).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("isVariableField", () => {
  it("names the two repeated fields and nothing else", () => {
    expect(isVariableField("variableKey")).toBe(true);
    expect(isVariableField("variableValue")).toBe(true);
    expect(isVariableField("name")).toBe(false);
    expect(isVariableField(undefined)).toBe(false);
  });
});

describe("rowErrorFor", () => {
  it("counts the index over submitted rows, not over rows on screen", () => {
    /*
     * The whole reason this module exists. Index 1 is the second *submitted* row, which is
     * `b` — counting over what is rendered would land on `blank-first`'s neighbour and put
     * a correct message against the wrong variable.
     */
    expect(rowErrorFor(refused({ field: "variableKey", index: 1 }), ROWS)).toEqual({
      rowId: "b",
      cell: "name",
      message: "Refused",
    });
  });

  it("puts a value error in the value cell", () => {
    expect(rowErrorFor(refused({ field: "variableValue", index: 0 }), ROWS)?.cell).toBe(
      "value",
    );
  });

  it("has nothing to say about a success, a plain failure or another field", () => {
    expect(rowErrorFor({ ok: true, message: "Done" }, ROWS)).toBeUndefined();
    expect(rowErrorFor(null, ROWS)).toBeUndefined();
    expect(rowErrorFor(refused({}), ROWS)).toBeUndefined();
    expect(rowErrorFor(refused({ field: "name" }), ROWS)).toBeUndefined();
  });

  it("yields an empty row id when the index names a row that was not submitted", () => {
    // Degrades to unattached rather than throwing: the editor renders no cell error, and
    // the caller's toast rule is what carries the message instead.
    expect(rowErrorFor(refused({ field: "variableKey", index: 9 }), ROWS)?.rowId).toBe(
      "",
    );
  });
});

describe("isUnattributable", () => {
  it("is true for a failure naming no field at all", () => {
    expect(isUnattributable(refused({}))).toBe(true);
  });

  it("is true for a variable rule about the list rather than one row", () => {
    // "Too many rows" and "too large together" have no row to point at, and were the cases
    // being swallowed silently before either form checked for them.
    expect(isUnattributable(refused({ field: "variableKey" }))).toBe(true);
  });

  it("is false when the error has an input to render beside", () => {
    expect(isUnattributable(refused({ field: "name" }))).toBe(false);
    expect(isUnattributable(refused({ field: "variableKey", index: 0 }))).toBe(false);
  });

  it("is false for a success", () => {
    expect(isUnattributable({ ok: true, message: "Done" })).toBe(false);
  });
});
