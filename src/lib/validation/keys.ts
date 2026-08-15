/**
 * Every message key a validation rule can name, and the values those messages interpolate.
 *
 * Zod-free for the same reason `./patterns` is: `action-form.ts` reads both exports at the
 * bottom of this file to decide whether an issue's message is a key this app minted or
 * whatever zod generated on its own, and that decision needs no schema.
 *
 * The table and the two things derived from it were 550 lines apart in one file. They are
 * one subject — a set of keys, the sentences' arguments, and the membership test — and each
 * derived export exists precisely because a hand-written second copy of the set had already
 * drifted from it.
 */

import { LIMITS } from "@/lib/constants";

/**
 * Every catalog key a rule in this file can name, declared once.
 *
 * Every rule carries a catalog key as its message, and every rule carries one — the
 * silent `.min(1)` calls used to fall through to zod's own built-in English, which no
 * amount of translation would have reached. The action resolves them; see
 * `messageForIssue` in `src/app/dashboard/actions.ts`.
 *
 * Referenced by the rules rather than restated by them, and that is the whole point. The
 * rules used to carry bare `"validation.…"` literals and `VALIDATION_KEYS` below was a
 * hand-maintained mirror of them, linked by nothing. A rule added with its key forgotten
 * there did not fail — `messageForIssue` fell through to the generic `actions.invalidForm`
 * and the specific sentence was silently replaced by "check the form". Now a mistyped or
 * missing key is a typecheck error at the rule site, which is where it can be fixed.
 *
 * Several keys are named by two or three rules — `portInvalid` by both of `port`'s
 * refinements, `regionInvalid` by a length rule and a charset rule, `submissionInvalid` by
 * both halves of the idempotency check. Those are the sites that were free to drift.
 */
export const KEYS = {
  nameRequired: "validation.nameRequired",
  nameTooLong: "validation.nameTooLong",
  imageRequired: "validation.imageRequired",
  imageTooLong: "validation.imageTooLong",
  imageInvalid: "validation.imageInvalid",
  projectRequired: "validation.projectRequired",
  environmentRequired: "validation.environmentRequired",
  serviceRequired: "validation.serviceRequired",
  deploymentRequired: "validation.deploymentRequired",
  referenceInvalid: "validation.referenceInvalid",
  variableNameRequired: "validation.variableNameRequired",
  variableNameTooLong: "validation.variableNameTooLong",
  variableNameInvalid: "validation.variableNameInvalid",
  variableNameReserved: "validation.variableNameReserved",
  variableNameDuplicate: "validation.variableNameDuplicate",
  variableValueTooLong: "validation.variableValueTooLong",
  variableValueInvalid: "validation.variableValueInvalid",
  variablesTooMany: "validation.variablesTooMany",
  variablesTooLarge: "validation.variablesTooLarge",
  variablesMalformed: "validation.variablesMalformed",
  portInvalid: "validation.portInvalid",
  regionInvalid: "validation.regionInvalid",
  replicasInvalid: "validation.replicasInvalid",
  replicasTooMany: "validation.replicasTooMany",
  cpuInvalid: "validation.cpuInvalid",
  cpuTooLarge: "validation.cpuTooLarge",
  memoryInvalid: "validation.memoryInvalid",
  memoryTooLarge: "validation.memoryTooLarge",
  restartPolicyInvalid: "validation.restartPolicyInvalid",
  restartRetriesInvalid: "validation.restartRetriesInvalid",
  restartRetriesTooMany: "validation.restartRetriesTooMany",
  startCommandInvalid: "validation.startCommandInvalid",
  startCommandTooLong: "validation.startCommandTooLong",
  tooManyContainers: "validation.tooManyContainers",
  submissionInvalid: "validation.submissionInvalid",
  projectNameRequired: "validation.projectNameRequired",
  projectNameTooLong: "validation.projectNameTooLong",
  environmentNameRequired: "validation.environmentNameRequired",
  environmentNameTooLong: "validation.environmentNameTooLong",
} as const;

/**
 * The key a rule may name — the union of the table above, and nothing else.
 *
 * Load-bearing on the three helpers that take a message as an argument (`railwayId`,
 * `optionalCount`, `optionalAmount`): those literals live at the call site rather than in
 * the rule, so a bare string there would reopen exactly the hole the table closes.
 */
export type ValidationKey = (typeof KEYS)[keyof typeof KEYS];

/**
 * The values each interpolating key needs, keyed by the same table the rules read.
 *
 * Only the keys whose sentence states a bound are here; the rest interpolate nothing.
 * `portInvalid` is the one that needs two, because its sentence names a range.
 */
export const VALIDATION_VALUES: Record<string, Record<string, number>> = {
  [KEYS.nameTooLong]: { max: LIMITS.CONTAINER_NAME_MAX },
  [KEYS.imageTooLong]: { max: LIMITS.IMAGE_REF_MAX },
  [KEYS.variableNameTooLong]: { max: LIMITS.VARIABLE_NAME_MAX },
  [KEYS.variableValueTooLong]: { max: LIMITS.VARIABLE_VALUE_MAX },
  [KEYS.variablesTooMany]: { max: LIMITS.VARIABLES_MAX },
  [KEYS.variablesTooLarge]: { max: LIMITS.VARIABLES_TOTAL_MAX },
  [KEYS.portInvalid]: { min: LIMITS.PORT_MIN, max: LIMITS.PORT_MAX },
  [KEYS.replicasTooMany]: { max: LIMITS.REPLICAS_MAX },
  [KEYS.cpuTooLarge]: { max: LIMITS.VCPU_MAX },
  [KEYS.memoryTooLarge]: { max: LIMITS.MEMORY_GB_MAX },
  [KEYS.restartRetriesTooMany]: { max: LIMITS.RESTART_RETRIES_MAX },
  [KEYS.startCommandTooLong]: { max: LIMITS.START_COMMAND_MAX },
  [KEYS.tooManyContainers]: { max: LIMITS.BULK_DESTROY_MAX },
  [KEYS.projectNameTooLong]: { max: LIMITS.PROJECT_NAME_MAX },
  [KEYS.environmentNameTooLong]: { max: LIMITS.ENVIRONMENT_NAME_MAX },
};

/**
 * Every catalog key the schemas above can produce.
 *
 * Exists so the action can tell "a key one of these rules named" from "whatever zod
 * generated when no rule applied" — the two are both strings on `issue.message`, and
 * treating the second as a key is how zod's own English reached a toast.
 *
 * Derived from the table rather than restating it. This was a second hand-written list of
 * the same 38 strings, so the set and the rules could disagree and only a user would find
 * out — the missing key degraded to `actions.invalidForm` rather than failing anything.
 */
export const VALIDATION_KEYS: ReadonlySet<string> = new Set(Object.values(KEYS));
