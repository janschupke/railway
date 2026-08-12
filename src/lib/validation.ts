import { z } from "zod";
import { LIMITS } from "@/lib/constants";

/**
 * Docker image reference: `[registry/]name[:tag][@digest]`.
 * Deliberately permissive on registry hosts, strict on shell-unsafe characters.
 */
export const IMAGE_PATTERN =
  /^[a-z0-9]+([._\-/][a-z0-9]+)*(:[\w][\w.\-]{0,127})?(@sha256:[a-f0-9]{64})?$/i;

export const spinUpSchema = z.object({
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1, "Give the container a name")
    .max(
      LIMITS.CONTAINER_NAME_MAX,
      `Keep the name under ${LIMITS.CONTAINER_NAME_MAX} characters`,
    ),
  image: z
    .string()
    .trim()
    .min(1, "An image reference is required")
    .max(LIMITS.IMAGE_REF_MAX)
    .regex(IMAGE_PATTERN, "That does not look like a valid image reference"),
});

export const spinDownSchema = z.object({
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  serviceId: z.string().min(1),
});

export type SpinUpInput = z.infer<typeof spinUpSchema>;
export type SpinDownInput = z.infer<typeof spinDownSchema>;
