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
 * Bounds charset and length rather than asserting a format. Railway's ids look like
 * UUIDs today, but this app has no way to prove that — and a validator that guesses
 * wrong turns every log pane into a 400. What matters is that path separators, dots and
 * unbounded input cannot reach the GraphQL layer; the concurrency cap and the
 * missing-deployment timeout are what bound the abuse, and neither depends on the shape.
 */
export const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Every rule carries a catalog key as its message, and every rule carries one — the
 * silent `.min(1)` calls used to fall through to zod's own built-in English, which no
 * amount of translation would have reached.
 *
 * The action resolves these keys; see `messageForIssue` in ./validation-messages.
 */
export const spinUpSchema = z.object({
  projectId: z.string().min(1, "validation.projectRequired"),
  environmentId: z.string().min(1, "validation.environmentRequired"),
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
  projectId: z.string().min(1, "validation.projectRequired"),
  environmentId: z.string().min(1, "validation.environmentRequired"),
  serviceId: z.string().min(1, "validation.serviceRequired"),
});

/** Catalog keys a validation issue can name, plus the values each interpolates. */
export const VALIDATION_VALUES: Record<string, Record<string, number>> = {
  "validation.nameTooLong": { max: LIMITS.CONTAINER_NAME_MAX },
  "validation.imageTooLong": { max: LIMITS.IMAGE_REF_MAX },
};
