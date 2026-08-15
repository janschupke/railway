import { z } from "zod";
import { LIMITS } from "@/lib/constants";
/*
 * The image rule moved to lib/registry/reference.ts and is imported back, rather than being
 * duplicated or re-exported from here. It is still the single definition of a valid
 * reference and this schema is still the only thing that refuses one — but the browser now
 * needs the same regex to decide whether an image is worth checking, and this module cannot
 * be the source of it: importing anything from here drags zod into /dashboard's first load.
 */
import { IMAGE_PATTERN } from "@/lib/registry/reference";
import type { RestartPolicyType } from "@/lib/railway/graphql.generated";

/**
 * Deployment id, as it arrives from the URL of the stream route.
 *
 * Bounds charset and length rather than asserting a format. Used for every Railway
 * identifier that arrives on a URL — deployments, projects, environments.
 * Railway's ids look like
 * UUIDs today, but this app has no way to prove that — and a validator that guesses
 * wrong turns every log pane into a 400. What matters is that path separators, dots and
 * unbounded input cannot reach the GraphQL layer; the concurrency cap and the
 * missing-deployment timeout are what bound the abuse, and neither depends on the shape.
 */
export const RAILWAY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The token the spin-up form mints to name one submission of itself.
 *
 * Not exported: nothing outside this file decides what a key may look like, and the
 * generator in lib/random-id.ts sits comfortably inside these bounds rather than at them.
 *
 * Both ends of the length matter, and for unrelated reasons. The floor is the security
 * one — a short key is a guessable key, and guessing one replays somebody else's result
 * instead of creating what they asked for. The ceiling is a memory one: this string
 * becomes half of a key in a process-global map, so unbounded is a growth surface. The
 * charset is the same one every Railway identifier uses here, which keeps it greppable
 * in a log line.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * An environment variable name: POSIX's own definition.
 *
 * Underscore or letter, then letters, digits and underscores. Deliberately not
 * uppercase-only — lowercase names are legal everywhere they matter, and a validator that
 * guesses stricter than the platform turns a working variable into a form error.
 *
 * Linear, with no nested quantifier and disjoint atom classes, so it is not ReDoS-able for
 * the same reason IMAGE_PATTERN is not. SECURITY.md makes that claim about the image regex
 * and a reviewer will ask it of this one.
 */
export const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Everything a value may hold: any character except the C0 controls and DEL, with tab
 * allowed through.
 *
 * The exclusion is the whole rule. A line break is invisible in a single-line input — the
 * browser's own value-sanitization algorithm strips it from a pasted string, so the user's
 * secret is silently truncated — and it survives to whatever downstream reads an
 * environment block line by line, which is the one character class that changes the shape
 * of what is being set rather than its content. NUL is refused at the other end of the
 * range for the same reason, and doubles as what a non-string FormData entry is coerced to
 * before it gets here.
 */
const VARIABLE_VALUE_PATTERN = /^[^\u0000-\u0008\u000A-\u001F\u007F]*$/;

/**
 * The namespace Railway sets itself.
 *
 * Railway injects a RAILWAY_* block into every service — environment, project id, service
 * name, the private and public domains. `variableCollectionUpsert` runs with
 * `replace: false`, so a collision is a silent merge in one direction or the other and the
 * loser is invisible. Refusing the namespace is cheaper than explaining it.
 *
 * Exported so presets.test.ts can prove no catalog entry is unsubmittable by its own form,
 * which is the failure mode this rule would otherwise create.
 */
export const RESERVED_VARIABLE_PREFIX = "RAILWAY_";

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
const KEYS = {
  nameRequired: "validation.nameRequired",
  nameTooLong: "validation.nameTooLong",
  imageRequired: "validation.imageRequired",
  imageTooLong: "validation.imageTooLong",
  imageInvalid: "validation.imageInvalid",
  projectRequired: "validation.projectRequired",
  environmentRequired: "validation.environmentRequired",
  serviceRequired: "validation.serviceRequired",
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
type ValidationKey = (typeof KEYS)[keyof typeof KEYS];

/**
 * A Railway identifier arriving from a form rather than from a URL.
 *
 * The route handlers already hold the same class of value to RAILWAY_ID_PATTERN before
 * doing anything expensive, and the reasoning there — path separators, dots and
 * unbounded input must not reach the GraphQL layer — applies identically here. These
 * fields were `.min(1)` only, so a ten-megabyte serviceId reached a full project query
 * before anything looked at it.
 */
const railwayId = (missing: ValidationKey) =>
  z
    .string()
    .min(1, missing)
    // The pattern carries the 64-character ceiling itself, so no separate .max().
    .regex(RAILWAY_ID_PATTERN, KEYS.referenceInvalid);

const variableName = z
  .string()
  .min(1, KEYS.variableNameRequired)
  .max(LIMITS.VARIABLE_NAME_MAX, KEYS.variableNameTooLong)
  .regex(VARIABLE_NAME_PATTERN, KEYS.variableNameInvalid)
  .refine(
    (name) => !name.toUpperCase().startsWith(RESERVED_VARIABLE_PREFIX),
    KEYS.variableNameReserved,
  );

const variableValue = z
  .string()
  .max(LIMITS.VARIABLE_VALUE_MAX, KEYS.variableValueTooLong)
  .regex(VARIABLE_VALUE_PATTERN, KEYS.variableValueInvalid);

/*
 * The environment editor arrives as two parallel arrays rather than an array of pairs, and
 * that is load-bearing rather than a serialisation accident.
 *
 * FormData preserves per-name insertion order and the two inputs' relative DOM order is
 * fixed by the row markup, so `variableKey[i]` and `variableValue[i]` are one row by
 * construction — there is no index to parse out of an attacker-chosen field name. More
 * importantly, zod's own array machinery then produces `issue.path === ["variableKey", 3]`,
 * which is exactly ActionResult's `field` plus `index` with nothing to translate.
 *
 * Reshaping this into `variables: z.array(z.object({ key, value }))` yields
 * `["variables", 3, "key"]` and silently loses the cell, which is how a row error becomes
 * "check the form". Do not tidy it.
 *
 * `.default([])` is what keeps every caller that sends no variable fields parsing, which is
 * both the pre-T-487 request shape and what a form posted without JavaScript still sends.
 */
/**
 * The fields both container forms carry, declared once.
 *
 * Spin-up and edit ask for the same four things — a name, an image, and the two parallel
 * variable arrays — under the same rules. Two copies would be two chances for the ceilings,
 * the charsets or the cross-row rules below to drift apart, and the copy that drifted would
 * be the one nobody was reading.
 */
const containerFields = {
  name: z
    .string()
    .trim()
    .min(1, KEYS.nameRequired)
    .max(LIMITS.CONTAINER_NAME_MAX, KEYS.nameTooLong),
  image: z
    .string()
    .trim()
    .min(1, KEYS.imageRequired)
    .max(LIMITS.IMAGE_REF_MAX, KEYS.imageTooLong)
    .regex(IMAGE_PATTERN, KEYS.imageInvalid),
  variableKey: z
    .array(variableName)
    .max(LIMITS.VARIABLES_MAX, KEYS.variablesTooMany)
    .default([]),
  variableValue: z.array(variableValue).default([]),
};

/**
 * The cross-row rules, as a `superRefine` body both schemas install.
 *
 * Per-cell rules stay on the element schemas above, where zod builds the path — and
 * therefore the row index — itself. Only the rules that need to see the whole list are here.
 */
const refineVariableRows = (
  data: { variableKey: string[]; variableValue: string[] },
  ctx: z.RefinementCtx,
): void => {
  if (data.variableKey.length !== data.variableValue.length) {
    // Nothing a browser can produce: the row markup emits both cells or neither. Bail
    // rather than validate one row's key against the next row's value.
    ctx.addIssue({
      code: "custom",
      path: ["variableKey"],
      message: KEYS.variablesMalformed,
    });
    return;
  }

  const seen = new Set<string>();
  for (const [index, key] of data.variableKey.entries()) {
    // Attributed to the second occurrence: the first one is the row the user meant.
    // Exact and case-sensitive — `Foo` and `FOO` are different variables on Linux.
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["variableKey", index],
        message: KEYS.variableNameDuplicate,
      });
    }
    seen.add(key);
  }

  const total =
    data.variableKey.reduce((sum, key) => sum + key.length, 0) +
    data.variableValue.reduce((sum, value) => sum + value.length, 0);
  if (total > LIMITS.VARIABLES_TOTAL_MAX) {
    ctx.addIssue({
      code: "custom",
      path: ["variableKey"],
      message: KEYS.variablesTooLarge,
    });
  }
};

/**
 * The two parallel lists, zipped back into rows.
 *
 * Lives here rather than in `actions.ts` because the guarantee it depends on lives here:
 * `refineVariableRows` above refuses a parse whose lists differ in length, so every key has
 * a value at its index. Both spin-up and edit did this inline, which put the assertion two
 * files away from the refinement that justifies it and meant the pairing rule was written
 * twice — the second copy free to drift from the first without anything noticing.
 *
 * The `!` is the one deliberate index assertion in `src/` outside `features/`, and it is
 * why `no-non-null-assertion` carries a disable here rather than an exemption for the
 * directory. Narrowing it would mean a branch for a state the parse has already refused:
 * unreachable, uncoverable against a 93% branch floor, and a lie about what can happen.
 * Kept to one place, next to its reason, rather than removed by making the code vaguer.
 */
export function pairVariableRows(data: {
  variableKey: string[];
  variableValue: string[];
}): Array<{ name: string; value: string }> {
  return data.variableKey.map((name, index) => ({
    name,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length refined above
    value: data.variableValue[index]!,
  }));
}

/**
 * The port a public domain should route to, and whether to mint one at all.
 *
 * One field carrying both, which is the design rather than an economy. A checkbox beside a
 * port would have a state that means nothing — ticked, with the port blank — and the app
 * would have to invent an answer for it. A port present says "give this container an
 * address, here"; a blank field says nothing was asked for.
 *
 * Blank is therefore ORDINARY and not an error: it is what every database preset submits,
 * and what the form posts when a person clears the seeded 80 because they did not want the
 * container exposed. `undefined`, never 0 — a falsy port and an absent one have to stay
 * tellable apart all the way down to `ServiceDomainCreateInput`.
 *
 * Coerced from a string because that is all FormData holds, and the digits are checked
 * BEFORE the coercion rather than after. Both of the obvious ways round are wrong on real
 * input: `parseInt("80abc")` is 80, so a typo becomes a working port aimed somewhere nobody
 * meant, and `Number` accepts `"0x50"` and `"1e3"` as 80 and 1000 — a field whose own
 * `inputMode` says numeric should not be quietly reading hex. A port is decimal digits.
 */
const DIGITS_PATTERN = /^\d+$/;

const port = z
  .string()
  .trim()
  .refine((value) => value === "" || DIGITS_PATTERN.test(value), KEYS.portInvalid)
  .transform((value) => (value === "" ? undefined : Number(value)))
  .refine(
    (value) =>
      value === undefined || (value >= LIMITS.PORT_MIN && value <= LIMITS.PORT_MAX),
    KEYS.portInvalid,
  )
  .optional();

/**
 * A whole number somebody may leave blank, checked as digits before it becomes one.
 *
 * The shape `port` above established, for the two reasons written there: `parseInt("3abc")`
 * is 3, so a typo silently becomes a working value, and `Number` reads `"0x10"` and `"1e3"`
 * as numbers a field asking for a count never meant. Blank survives as `undefined` rather
 * than collapsing to 0 — every field built from this means "leave it to Railway" when it is
 * empty, and 0 is a request Railway would honour.
 *
 * Two messages, not one: a value that is not a number and a value that is out of range are
 * different mistakes with different corrections, and the ceiling one interpolates the bound
 * so the sentence can say what it is.
 *
 * Shares `DIGITS_PATTERN` with `port` rather than declaring the same regex again four lines
 * from the docblock saying it is the same regex.
 */

const optionalCount = (bounds: {
  min: number;
  max: number;
  invalid: ValidationKey;
  tooLarge: ValidationKey;
}) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || DIGITS_PATTERN.test(value), bounds.invalid)
    .transform((value) => (value === "" ? undefined : Number(value)))
    .refine((value) => value === undefined || value >= bounds.min, bounds.invalid)
    .refine((value) => value === undefined || value <= bounds.max, bounds.tooLarge)
    .optional();

/**
 * A positive decimal somebody may leave blank. CPU and memory, and nothing else.
 *
 * Separate from `optionalCount` because Railway types both as `Float` and a quarter of a
 * vCPU is a real request — so the digits rule has to admit a decimal point, and the floor is
 * "greater than zero" rather than a minimum anyone chose. A service with 0 vCPU is not a
 * smaller service, it is a refused mutation.
 */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

const optionalAmount = (bounds: {
  max: number;
  invalid: ValidationKey;
  tooLarge: ValidationKey;
}) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || AMOUNT_PATTERN.test(value), bounds.invalid)
    .transform((value) => (value === "" ? undefined : Number(value)))
    .refine((value) => value === undefined || value > 0, bounds.invalid)
    .refine((value) => value === undefined || value <= bounds.max, bounds.tooLarge)
    .optional();

/**
 * Railway's region identifiers, bounded by charset and length rather than by membership.
 *
 * The form's options come from Railway's own `regions` list, so a person cannot type one of
 * these at all — which is what makes checking the value against that list a second Railway
 * round trip inside the Server Action to refuse something no browser produces. What this has
 * to stop is a hand-crafted request putting arbitrary text into a GraphQL variable, and a
 * charset and a ceiling stop exactly that. See SECURITY.md, "Input surfaces".
 *
 * Linear, disjoint atom classes, no nested quantifier — not ReDoS-able, for the reason
 * VARIABLE_NAME_PATTERN is not. Matches the empty string on purpose: blank is the ordinary
 * value, and it means Railway chooses.
 */
const REGION_PATTERN = /^[a-z0-9-]*$/;

/**
 * The three restart policies Railway offers.
 *
 * Typed against the generated `RestartPolicyType` rather than declared free-standing, so a
 * member Railway adds or removes fails `pnpm typecheck` here rather than being discovered by
 * a user whose choice is refused.
 */
const RESTART_POLICIES: readonly RestartPolicyType[] = [
  "ALWAYS",
  "NEVER",
  "ON_FAILURE",
];

/**
 * The resource controls behind the form's Advanced disclosure.
 *
 * Deliberately NOT in `containerFields`, and this is the one place where the tidier-looking
 * change is a data-loss bug. That object is shared with `containerEditSchema`, so an edit
 * form carrying these would post seven blank values for a service that is already running —
 * and blank means `undefined`, which `serviceInstanceUpdate` reads as "no change" only
 * because this app never sends the member at all. The moment an edit path builds an input
 * from these it is sending "unset the region, unset the replica count" to a container
 * somebody configured. An edit form can carry them once it reads the current values back off
 * `ServiceInstance` first, and not before.
 *
 * Every one is optional, every one means "leave it to Railway" when blank, and none of them
 * is settable on `ServiceCreateInput` — they are two follow-up mutations, which is why
 * createContainer has two more outcomes than it used to.
 */
const advancedFields = {
  region: z
    .string()
    .trim()
    .max(LIMITS.REGION_MAX, KEYS.regionInvalid)
    .regex(REGION_PATTERN, KEYS.regionInvalid)
    .transform((value) => (value === "" ? undefined : value))
    .optional(),
  replicas: optionalCount({
    min: 1,
    max: LIMITS.REPLICAS_MAX,
    invalid: KEYS.replicasInvalid,
    tooLarge: KEYS.replicasTooMany,
  }),
  cpu: optionalAmount({
    max: LIMITS.VCPU_MAX,
    invalid: KEYS.cpuInvalid,
    tooLarge: KEYS.cpuTooLarge,
  }),
  memory: optionalAmount({
    max: LIMITS.MEMORY_GB_MAX,
    invalid: KEYS.memoryInvalid,
    tooLarge: KEYS.memoryTooLarge,
  }),
  restartPolicy: z
    .string()
    .trim()
    .refine(
      (value) =>
        value === "" || (RESTART_POLICIES as readonly string[]).includes(value),
      KEYS.restartPolicyInvalid,
    )
    .transform((value) => (value === "" ? undefined : (value as RestartPolicyType)))
    .optional(),
  /*
   * Zero is a value someone means — "do not retry this at all" — so the floor is 0 and not
   * 1. It is also the number an obvious tidy-up would raise to match `replicas` above.
   */
  restartRetries: optionalCount({
    min: 0,
    max: LIMITS.RESTART_RETRIES_MAX,
    invalid: KEYS.restartRetriesInvalid,
    tooLarge: KEYS.restartRetriesTooMany,
  }),
  startCommand: z
    .string()
    .trim()
    .max(LIMITS.START_COMMAND_MAX, KEYS.startCommandTooLong)
    /*
     * The exclusion a variable value carries, for the same reason: a line break is invisible
     * in a single-line input — the browser's own sanitiser strips it out of a pasted string
     * — and it changes the shape of what is being set rather than its content.
     */
    .regex(VARIABLE_VALUE_PATTERN, KEYS.startCommandInvalid)
    .transform((value) => (value === "" ? undefined : value))
    .optional(),
};

export const spinUpSchema = z
  .object({
    projectId: railwayId(KEYS.projectRequired),
    environmentId: railwayId(KEYS.environmentRequired),
    ...containerFields,
    /*
     * On spin-up only, and deliberately not in `containerFields` beside the image it goes
     * with. Editing a container cannot mint a domain: `serviceDomainCreate` refuses a
     * service that already has one, and a port field on the edit form would be a control
     * that does nothing on every container that already answers somewhere. The row is where
     * a container without an address gets one.
     */
    port,
    /*
     * After every visible field and before the key, which is error priority rather than
     * tidiness: zod reports shape issues in declaration order and the action reads
     * `issues[0]`, so a typo in the name — which is on screen — outranks a replica count
     * behind a closed disclosure, and both outrank a form that arrived without its key.
     */
    ...advancedFields,
    /*
     * Last on purpose. Zod reports shape issues in declaration order and the action reads
     * `issues[0]`, so anything a person can actually fix — the name, the image, a variable
     * row — outranks a form that arrived without its key. A user shown "reload the page"
     * for a typo they could have corrected would have no way to know that.
     */
    idempotencyKey: z
      .string()
      .min(1, KEYS.submissionInvalid)
      .regex(IDEMPOTENCY_KEY_PATTERN, KEYS.submissionInvalid),
  })
  .superRefine(refineVariableRows);

/**
 * Editing a container that already exists.
 *
 * The same four fields spin-up carries, plus the service being edited, and deliberately
 * without an idempotency key: a repeated edit converges rather than duplicating — the second
 * submission of the same form renames a service to the name it already has — so the
 * duplicate-submit hazard `spinUpSchema` guards is not one this request shape has.
 *
 * What is *not* here is any statement about which variables already exist. The form posts
 * the rows it wants to end up with; the action re-derives the prior set from Railway and
 * works out the difference. A client-supplied "these were already set" list would be a
 * client-supplied instruction to delete, which is the same class of thing as a
 * client-supplied ownership claim — see withManagedContainer.
 */
export const containerEditSchema = z
  .object({
    projectId: railwayId(KEYS.projectRequired),
    environmentId: railwayId(KEYS.environmentRequired),
    serviceId: railwayId(KEYS.serviceRequired),
    ...containerFields,
  })
  .superRefine(refineVariableRows);

/*
 * The two create schemas.
 *
 * Names are bounded and trimmed and nothing else. There is no charset rule on purpose:
 * `toManagedName` does not run here — this app never destroys a project or an environment,
 * so there is no ownership prefix to derive and no slug to keep round-trippable — and the
 * name is passed to Railway verbatim, rendered as text, and never interpolated into a
 * path, a URL or a shell. A pattern here would only reject project names people legitimately
 * write, which is the failure mode the RAILWAY_ID_PATTERN comment above warns about.
 */
export const projectCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, KEYS.projectNameRequired)
    .max(LIMITS.PROJECT_NAME_MAX, KEYS.projectNameTooLong),
});

export const environmentCreateSchema = z.object({
  projectId: railwayId(KEYS.projectRequired),
  name: z
    .string()
    .trim()
    .min(1, KEYS.environmentNameRequired)
    .max(LIMITS.ENVIRONMENT_NAME_MAX, KEYS.environmentNameTooLong),
});

/**
 * One container, named by the three ids every lifecycle action posts.
 *
 * Was `spinDownSchema`, when destroy was the only thing that could be done to a container
 * that already exists. Stop, restart and redeploy send exactly the same three fields —
 * nothing about a lifecycle request is per-verb, because the deployment id is read back
 * from Railway rather than accepted from the browser.
 */
export const containerActionSchema = z.object({
  projectId: railwayId(KEYS.projectRequired),
  environmentId: railwayId(KEYS.environmentRequired),
  serviceId: railwayId(KEYS.serviceRequired),
});

/**
 * Several containers, named by one repeated field.
 *
 * The same three names the singular schema uses, with `serviceId` arriving as a list — the
 * repeated-native-field shape the variables editor already established, which is why the
 * action reads it with `formList` and no index is ever written into a field name.
 *
 * The ceiling is the rule worth stating. Every other bound in this file protects a value;
 * this one protects the *quota*, because one submission becomes one `serviceDelete` per
 * entry and the browser decides how many entries there are. It is checked before anything is
 * read from Railway and long before anything is deleted, so an oversized batch costs a form
 * error rather than a partial teardown.
 *
 * Ownership is not here and cannot be: the list says which services, and only Railway's own
 * answer says whether this app may touch them. See `resolveManagedTarget`.
 */
export const containerBulkActionSchema = z.object({
  projectId: railwayId(KEYS.projectRequired),
  environmentId: railwayId(KEYS.environmentRequired),
  serviceId: z
    .array(railwayId(KEYS.serviceRequired))
    .min(1, KEYS.serviceRequired)
    .max(LIMITS.BULK_DESTROY_MAX, KEYS.tooManyContainers),
});

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

/**
 * The fields behind the spin-up form's Advanced disclosure, by name.
 *
 * Exported for a test rather than for the form. `spin-up-form.tsx` keeps its own copy of
 * this list — it opens the collapsed `<details>` when a failure names one, and an inline
 * error inside a closed panel is silence — but it cannot import it from here: importing
 * anything from this module drags zod into /dashboard's first load, which is the reason
 * IMAGE_PATTERN lives in lib/registry/reference.ts and not in this file.
 *
 * So the two lists stay separate and a test holds them together, which costs a bundle
 * nothing. Without it, adding a seventh advanced field leaves the form silently unable to
 * reveal its error.
 */
export const ADVANCED_FIELD_NAMES: readonly string[] = Object.keys(advancedFields);
