import "server-only";

import { randomBytes } from "node:crypto";
import type { PresetVariable } from "@/lib/presets";

/**
 * Bytes of entropy per generated credential. 24 bytes is 32 base64url characters, which
 * is well past anything a database password needs and short enough to select by hand.
 */
const PASSWORD_BYTES = 24;

/** One row of the environment editor, after the schema has bounded it. */
export type SubmittedVariable = { name: string; value: string };

export type ResolvedVariables = {
  /** `undefined`, not `{}`: the caller uses the absence to skip the mutation entirely. */
  variables: Record<string, string> | undefined;
  /**
   * Whether anything here was minted rather than typed.
   *
   * The user has no copy of a minted value and has to be told where to read it; they have
   * their own copy of one they typed, and telling them to go look it up on Railway would
   * be a lie. That sentence is the only reason this flag exists.
   */
  generated: boolean;
};

/**
 * Merges the catalog's defaults with the rows the user submitted, minting what is left
 * blank and the catalog owns.
 *
 * This function is the second of the three bounds that replaced "the client cannot inject
 * environment" — it bounds *authority*, where the schema bounds shape. It is the only
 * thing in the app that mints a credential, and the set of names it will mint for is built
 * from the catalog and the submitted image, never from the request:
 *
 *   A submitted row whose value is blank, and whose name the catalog declares `generate`
 *   for this image, gets a freshly minted secret. Every other blank value is "".
 *
 * So "generate me a secret" is not a request shape. A row named MY_KEY left blank on
 * postgres gets an empty string, not a password.
 *
 * Generated values are returned and never retained. They are not logged, not stored, and
 * not sent to the browser — the user reads them on Railway's own service → Variables page,
 * which is where every other Railway secret lives. A user who wants a password they can
 * keep types one into the editor; this app still has no database and is still not going to
 * become a password manager. See SECURITY.md, "Input surfaces".
 */
export function resolveVariables(
  presetVariables: readonly PresetVariable[] | undefined,
  submitted?: readonly SubmittedVariable[],
): ResolvedVariables {
  /*
   * Built from the CATALOG, never from the request. This is the whole of what survived of
   * the pre-T-487 property, and it is one line.
   */
  const mintable = new Set(
    (presetVariables ?? [])
      .filter((variable) => "generate" in variable)
      .map((variable) => variable.name),
  );

  if (!submitted?.length) {
    /*
     * No editor on the wire: the pre-T-487 path, unchanged. Still reachable, and not only
     * by old callers — a form posted without JavaScript sends no variable fields either.
     */
    if (!presetVariables?.length) return { variables: undefined, generated: false };

    const resolved: Record<string, string> = {};
    for (const variable of presetVariables) {
      resolved[variable.name] =
        "generate" in variable
          ? randomBytes(PASSWORD_BYTES).toString("base64url")
          : variable.value;
    }
    return { variables: resolved, generated: mintable.size > 0 };
  }

  /*
   * The submitted rows are the whole key set. A catalog default the user did not send is
   * not added back — that would be the hidden merge this ticket replaced, and it would
   * mean a row someone deliberately cleared reappearing on the service.
   */
  const resolved: Record<string, string> = {};
  let generated = false;
  for (const { name, value } of submitted) {
    if (value === "" && mintable.has(name)) {
      resolved[name] = randomBytes(PASSWORD_BYTES).toString("base64url");
      generated = true;
    } else {
      resolved[name] = value;
    }
  }
  return { variables: resolved, generated };
}
