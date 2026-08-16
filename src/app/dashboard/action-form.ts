import "server-only";

import type { getTranslations } from "next-intl/server";
import type { z } from "zod";
import {
  describeActionError,
  isField,
  type ActionField,
  type ActionResult,
} from "@/lib/action-result";
import { presetFor } from "@/lib/presets";
import { VALIDATION_KEYS, VALIDATION_VALUES } from "@/lib/validation/keys";
import type { Translate } from "@/lib/messages";

/**
 * What every Server Action needs before it does anything of its own: read a field, turn a
 * failed parse into a result, turn a thrown value into a result, and describe a service's
 * environment for the audit line without naming what a user typed.
 *
 * A plain module rather than part of actions.ts, because a `"use server"` file may export
 * only async functions — the SWC transform in Next 16 says so outright — so a type, a
 * constant or a synchronous helper cannot live beside the actions that use it. Next's own
 * data-security guide prescribes exactly this shape: thin actions delegating to modules
 * that are not themselves an action surface.
 */

/**
 * Server Actions resolve copy themselves.
 *
 * The result is rendered by a toast the client already owns, so shipping a key back and
 * translating there would mean the client needing the error namespace loaded for
 * messages it may never show.
 */
export type Translator = Awaited<ReturnType<typeof getTranslations>>;

const asTranslate =
  (t: Translator): Translate =>
  (key, values) =>
    t(key as Parameters<Translator>[0], values as never);

/**
 * Zod issues carry catalog keys as their `message`; some also interpolate a limit.
 *
 * Guarded, because "the message is a key" holds only for rules that actually fired. A
 * field missing from the FormData entirely fails the implicit string check *before* any
 * `.min()` runs, so `issue.message` is zod's own English — and next-intl echoes an
 * unknown key back verbatim, which is how "Invalid input: expected string, received
 * null" ended up in a toast. The boundary coercion below stops that arising; this stops
 * the next rule added without a message doing it again.
 */
function messageForIssue(t: Translator, key: string): string {
  // Same cast as every other call through the `Translator` alias, which resolves to the
  // namespaced overload and so is narrower than the value `getTranslations()` returns.
  if (!VALIDATION_KEYS.has(key)) {
    return t("actions.invalidForm" as Parameters<Translator>[0]);
  }
  const values = VALIDATION_VALUES[key];
  return t(key as Parameters<Translator>[0], values as never);
}

/**
 * Not `MessageKey`: that union is the `errors.*` subset reachable from code with no
 * translator, and these two are ordinary catalog keys resolved right here. Spelled as a
 * literal union rather than `string` so a typo is a compile error, and so the set stays
 * small enough to read — a third fallback is a question worth asking, not a default.
 */
type IssueFallbackKey = "actions.invalidForm" | "actions.missingReference";

type IssueShape = {
  /** Schema field name → the `ActionField` the form actually renders. */
  rename?: Readonly<Record<string, ActionField>>;
  /** The message when zod produced no issue at all. */
  fallback?: IssueFallbackKey;
  /** Off for schemas whose every field is a hidden input. */
  attribute?: false;
};

/**
 * A failed parse, as the result the caller returns.
 *
 * Written five times before this, and three of the copies had already drifted: spin-up and
 * edit carried the full field-and-index attribution, `addProject` hardcoded a field name
 * rather than reading the path, `addEnvironment` remapped one, and `destroyMany` dropped
 * attribution altogether and used a different fallback. Four behaviours from one rule, none
 * of them wrong exactly, and no way to tell deliberate from forgotten by reading them.
 *
 * The differences are the three options above, so they are stated rather than reimplemented:
 *
 * `rename` exists because two schemas call their field `name` while the form renders it as
 * `projectName` or `environmentName`. Without it the attribution lands on an input that is
 * not on the page, which reads to the user as no error at all.
 *
 * `fallback` is for an error with no issues in it — a shape no browser produces.
 * `destroyMany` wants a different sentence for that than the forms do.
 *
 * `attribute: false` is `destroyMany` again: every field it validates is a hidden input the
 * page filled in, so there is nothing on screen to point at and the message has to be a toast.
 */
export function issueToResult(
  t: Translator,
  error: z.ZodError,
  { rename, fallback = "actions.invalidForm", attribute }: IssueShape = {},
): ActionResult {
  const issue = error.issues[0];
  // The same cast every call through `Translator` makes; see messageForIssue.
  if (!issue) return { ok: false, error: t(fallback as Parameters<Translator>[0]) };

  const result: ActionResult = {
    ok: false,
    error: messageForIssue(t, issue.message),
  };
  if (attribute === false) return result;

  const [path, index] = issue.path;
  const field =
    typeof path === "string" && rename?.[path]
      ? rename[path]
      : isField(path)
        ? path
        : null;
  if (!field) return result;

  return {
    ...result,
    field,
    /*
     * Only meaningful alongside a field, and only ever present for the repeated ones — zod
     * builds the row index into the path itself. A rule about the whole list (too many rows,
     * too large together) carries no index, and the form has to toast those rather than look
     * for a row that does not exist.
     */
    ...(typeof index === "number" ? { index } : {}),
  };
}

/**
 * Any thrown value, as the result the caller returns.
 *
 * The five catch blocks that used to hold these two lines were byte-identical, and
 * `data-containers.ts` has a sixth against `reportError`. Both casts go with them: `describeActionError`
 * already returns a `MessageDescriptor` whose key is a `MessageKey`, so `key as MessageKey`
 * was re-asserting a type the value already had, and `asTranslate` exists precisely to make
 * the second one unnecessary.
 */
export function toActionError(t: Translator, error: unknown): ActionResult {
  const { key, values } = describeActionError(error);
  return { ok: false, error: asTranslate(t)(key, values) };
}

/**
 * The two audit fields describing a service's environment, split by who chose the names.
 *
 * SECURITY.md's bounded-cardinality rule, expressed once. Preset-derived names come from
 * this app's own catalog, so they are a closed set and safe to name; everything else a
 * person typed is unbounded and attacker-chosen in exactly the way the rejected
 * `deploymentId` is, so it is counted instead. The record says how many variables a user
 * set, not which — an accepted loss, argued in SECURITY.md.
 *
 * `container.created` and `container.updated` each computed this inline, identically. Two
 * copies of a redaction rule is one copy that can quietly start logging the names.
 */
export function variableAudit(
  image: string,
  variables: Record<string, string> | undefined,
): { variable_names: string; user_variable_count: number } {
  const presetNames = new Set(
    (presetFor(image)?.variables ?? []).map((variable) => variable.name),
  );
  const sentNames = variables ? Object.keys(variables) : [];
  const presetSent = sentNames.filter((sent) => presetNames.has(sent));
  return {
    variable_names: presetSent.join(","),
    user_variable_count: sentNames.length - presetSent.length,
  };
}

/**
 * A FormData field as a string.
 *
 * `formData.get` returns null for a field the browser never sent, and null fails zod's
 * type check ahead of the rule that carries the catalog key. Coercing here means the
 * `.min(1)` message is the one that fires, which is the message written for this case.
 */
export const formField = (formData: FormData, name: string): string =>
  String(formData.get(name) ?? "");

/**
 * A repeated FormData field, as strings.
 *
 * `getAll` rather than `get`: the environment editor posts one entry per row under a
 * single name, and FormData preserves per-name insertion order, so index i of the two
 * lists is one row without an index ever being written down.
 *
 * A non-string entry is a hand-crafted request rather than anything a browser sends, and
 * it has no honest coercion — `""` is what asks the catalog for a generated credential, so
 * coercing to it would turn a `File` part into a request for a secret. It becomes a byte
 * the value schema refuses instead.
 */
export const formList = (formData: FormData, name: string): string[] =>
  formData.getAll(name).map((entry) => (typeof entry === "string" ? entry : "\u0000"));
