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
 * Every rule carries a catalog key as its message, and every rule carries one — the
 * silent `.min(1)` calls used to fall through to zod's own built-in English, which no
 * amount of translation would have reached.
 *
 * The action resolves these keys; see `messageForIssue` in ./validation-messages.
 */
/**
 * A Railway identifier arriving from a form rather than from a URL.
 *
 * The route handlers already hold the same class of value to RAILWAY_ID_PATTERN before
 * doing anything expensive, and the reasoning there — path separators, dots and
 * unbounded input must not reach the GraphQL layer — applies identically here. These
 * fields were `.min(1)` only, so a ten-megabyte serviceId reached a full project query
 * before anything looked at it.
 */
const railwayId = (missing: string) =>
  z
    .string()
    .min(1, missing)
    // The pattern carries the 64-character ceiling itself, so no separate .max().
    .regex(RAILWAY_ID_PATTERN, "validation.referenceInvalid");

const variableName = z
  .string()
  .min(1, "validation.variableNameRequired")
  .max(LIMITS.VARIABLE_NAME_MAX, "validation.variableNameTooLong")
  .regex(VARIABLE_NAME_PATTERN, "validation.variableNameInvalid")
  .refine(
    (name) => !name.toUpperCase().startsWith(RESERVED_VARIABLE_PREFIX),
    "validation.variableNameReserved",
  );

const variableValue = z
  .string()
  .max(LIMITS.VARIABLE_VALUE_MAX, "validation.variableValueTooLong")
  .regex(VARIABLE_VALUE_PATTERN, "validation.variableValueInvalid");

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
export const spinUpSchema = z
  .object({
    projectId: railwayId("validation.projectRequired"),
    environmentId: railwayId("validation.environmentRequired"),
    name: z
      .string()
      .trim()
      .min(1, "validation.nameRequired")
      .max(LIMITS.CONTAINER_NAME_MAX, "validation.nameTooLong"),
    image: z
      .string()
      .trim()
      .min(1, "validation.imageRequired")
      .max(LIMITS.IMAGE_REF_MAX, "validation.imageTooLong")
      .regex(IMAGE_PATTERN, "validation.imageInvalid"),
    variableKey: z
      .array(variableName)
      .max(LIMITS.VARIABLES_MAX, "validation.variablesTooMany")
      .default([]),
    variableValue: z.array(variableValue).default([]),
    /*
     * Last on purpose. Zod reports shape issues in declaration order and the action reads
     * `issues[0]`, so anything a person can actually fix — the name, the image, a variable
     * row — outranks a form that arrived without its key. A user shown "reload the page"
     * for a typo they could have corrected would have no way to know that.
     */
    idempotencyKey: z
      .string()
      .min(1, "validation.submissionInvalid")
      .regex(IDEMPOTENCY_KEY_PATTERN, "validation.submissionInvalid"),
  })
  .superRefine((data, ctx) => {
    /*
     * Cross-row rules only. Per-cell rules live on the element schemas above, where zod
     * builds the path — and therefore the row index — itself.
     */
    if (data.variableKey.length !== data.variableValue.length) {
      // Nothing a browser can produce: the row markup emits both cells or neither. Bail
      // rather than validate one row's key against the next row's value.
      ctx.addIssue({
        code: "custom",
        path: ["variableKey"],
        message: "validation.variablesMalformed",
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
          message: "validation.variableNameDuplicate",
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
        message: "validation.variablesTooLarge",
      });
    }
  });

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
    .min(1, "validation.projectNameRequired")
    .max(LIMITS.PROJECT_NAME_MAX, "validation.projectNameTooLong"),
});

export const environmentCreateSchema = z.object({
  projectId: railwayId("validation.projectRequired"),
  name: z
    .string()
    .trim()
    .min(1, "validation.environmentNameRequired")
    .max(LIMITS.ENVIRONMENT_NAME_MAX, "validation.environmentNameTooLong"),
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
  projectId: railwayId("validation.projectRequired"),
  environmentId: railwayId("validation.environmentRequired"),
  serviceId: railwayId("validation.serviceRequired"),
});

/** Catalog keys a validation issue can name, plus the values each interpolates. */
export const VALIDATION_VALUES: Record<string, Record<string, number>> = {
  "validation.nameTooLong": { max: LIMITS.CONTAINER_NAME_MAX },
  "validation.imageTooLong": { max: LIMITS.IMAGE_REF_MAX },
  "validation.variableNameTooLong": { max: LIMITS.VARIABLE_NAME_MAX },
  "validation.variableValueTooLong": { max: LIMITS.VARIABLE_VALUE_MAX },
  "validation.variablesTooMany": { max: LIMITS.VARIABLES_MAX },
  "validation.variablesTooLarge": { max: LIMITS.VARIABLES_TOTAL_MAX },
  "validation.projectNameTooLong": { max: LIMITS.PROJECT_NAME_MAX },
  "validation.environmentNameTooLong": { max: LIMITS.ENVIRONMENT_NAME_MAX },
};

/**
 * Every catalog key the schemas above can produce.
 *
 * Exists so the action can tell "a key one of these rules named" from "whatever zod
 * generated when no rule applied" — the two are both strings on `issue.message`, and
 * treating the second as a key is how zod's own English reached a toast.
 */
export const VALIDATION_KEYS: ReadonlySet<string> = new Set([
  "validation.nameRequired",
  "validation.nameTooLong",
  "validation.imageRequired",
  "validation.imageTooLong",
  "validation.imageInvalid",
  "validation.projectRequired",
  "validation.environmentRequired",
  "validation.serviceRequired",
  "validation.referenceInvalid",
  "validation.variableNameRequired",
  "validation.variableNameTooLong",
  "validation.variableNameInvalid",
  "validation.variableNameReserved",
  "validation.variableNameDuplicate",
  "validation.variableValueTooLong",
  "validation.variableValueInvalid",
  "validation.variablesTooMany",
  "validation.variablesTooLarge",
  "validation.variablesMalformed",
  "validation.submissionInvalid",
  "validation.projectNameRequired",
  "validation.projectNameTooLong",
  "validation.environmentNameRequired",
  "validation.environmentNameTooLong",
]);
