import { z } from "zod";
import { LIMITS } from "@/lib/constants";

/**
 * Docker image reference: `[registry/]name[:tag][@digest]`.
 * Deliberately permissive on registry hosts, strict on shell-unsafe characters.
 */
const IMAGE_PATTERN =
  /^[a-z0-9]+([._\-/][a-z0-9]+)*(:[\w][\w.\-]{0,127})?(@sha256:[a-f0-9]{64})?$/i;

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

export const spinUpSchema = z.object({
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
});

export const spinDownSchema = z.object({
  projectId: railwayId("validation.projectRequired"),
  environmentId: railwayId("validation.environmentRequired"),
  serviceId: railwayId("validation.serviceRequired"),
});

/** Catalog keys a validation issue can name, plus the values each interpolates. */
export const VALIDATION_VALUES: Record<string, Record<string, number>> = {
  "validation.nameTooLong": { max: LIMITS.CONTAINER_NAME_MAX },
  "validation.imageTooLong": { max: LIMITS.IMAGE_REF_MAX },
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
]);
