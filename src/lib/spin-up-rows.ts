/**
 * What the spin-up form's variable rows and port field do when the image changes.
 *
 * One rule runs through all of it: **nothing a person typed is thrown away by changing the
 * image.** That is easy to state and easy to get subtly wrong, and it was expressed across
 * four regions of a 657-line component — a row type, a seeder, a reseeder and the handler
 * that called them — so the only way to check it was to render a form and drive it.
 *
 * Pure, and in the unit tier: no React, no DOM, no catalog lookup beyond the one this
 * module already depends on.
 */

import { httpPortFor, presetVariableDefaults } from "./presets";

const PRESET_ORIGIN = "preset" as const;
const USER_ORIGIN = "user" as const;

/**
 * A variable row plus what the form needs to know about where it came from.
 *
 * Structural rather than importing `KeyValueRow` from the editor: that is a client
 * component, and this is the tier that must not reach into one. The editor's own type is
 * assignable to this.
 */
export type VariableRow = {
  id: string;
  name: string;
  value: string;
  locked?: boolean;
  blankMeans?: "generated" | "unchanged";
  origin: "preset" | "user";
  /** Whether a person has edited either cell since it was seeded. */
  touched: boolean;
};

/** Catalog defaults as locked rows: the name is the catalog's, the value is the user's. */
export function seedRows(image: string): VariableRow[] {
  return presetVariableDefaults(image).map((variable) => ({
    // Stable across a reseed, so switching images and back does not move focus.
    id: `preset-${variable.name}`,
    name: variable.name,
    value: variable.value,
    locked: true,
    ...(variable.generated ? { blankMeans: "generated" as const } : {}),
    origin: PRESET_ORIGIN,
    touched: false,
  }));
}

/**
 * The rows an image change should leave behind.
 *
 * A touched preset row survives and stops being locked, since the catalog that owned its
 * name is gone; an untouched one is replaced. A user row whose name collides with a new
 * preset default wins, and that default is not seeded — which is what keeps the duplicate
 * rule from firing on something the app itself created.
 */
export function reseed(rows: readonly VariableRow[], image: string): VariableRow[] {
  const keep = rows
    .filter((row) => row.origin === USER_ORIGIN || row.touched)
    .map((row) => ({ ...row, locked: false }));
  const seeded = seedRows(image).filter(
    (row) => !keep.some((kept) => kept.name === row.name),
  );
  return [...seeded, ...keep];
}

/**
 * Re-attaches the provenance the editor does not carry.
 *
 * `KeyValueEditor` is domain-free — it holds rows of two strings and knows nothing about
 * catalogs — so `origin` and `touched` are matched back on by row id. A row the editor
 * invented is a user row, and any edit to either cell marks it touched, which is what stops
 * the next image change from discarding it.
 */
export function reattachProvenance(
  next: readonly { id: string; name: string; value: string }[],
  previous: readonly VariableRow[],
): VariableRow[] {
  return next.map((row) => {
    const was = previous.find((candidate) => candidate.id === row.id);
    return {
      ...row,
      origin: was?.origin ?? USER_ORIGIN,
      touched:
        was === undefined ||
        was.touched ||
        was.name !== row.name ||
        was.value !== row.value,
    };
  });
}

/**
 * The port field's seeded value for an image, as the input holds it.
 *
 * A string because that is what an `<input>` value is, and the empty string is the whole of
 * "this image gets no public URL" — for a preset the catalog knows serves nothing, and for
 * an image it has never heard of. Those two are the same blank field on purpose: in both
 * cases the app has no port to offer, and the person is the one who knows.
 */
export const portFor = (image: string): string => {
  const known = httpPortFor(image);
  return known === undefined ? "" : String(known);
};
