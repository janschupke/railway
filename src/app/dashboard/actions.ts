"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAccessToken, SessionExpiredError } from "@/lib/auth/server";
import {
  createContainer,
  destroyContainer,
  getProjectContainers,
} from "@/lib/railway/api";
import { RailwayApiError } from "@/lib/railway/errors";
import { toManagedName } from "@/lib/railway/managed";

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; field?: "name" | "image" };

/**
 * Docker image reference: `[registry/]name[:tag][@digest]`.
 * Deliberately permissive on registry hosts, strict on shell-unsafe characters.
 */
const IMAGE_PATTERN = /^[a-z0-9]+([._\-/][a-z0-9]+)*(:[\w][\w.\-]{0,127})?(@sha256:[a-f0-9]{64})?$/i;

const spinUpSchema = z.object({
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1, "Give the container a name")
    .max(40, "Keep the name under 40 characters"),
  image: z
    .string()
    .trim()
    .min(1, "An image reference is required")
    .max(255)
    .regex(IMAGE_PATTERN, "That does not look like a valid image reference"),
});

function toResult(error: unknown): ActionResult {
  if (error instanceof SessionExpiredError) {
    return { ok: false, error: "Your Railway session expired. Sign in again." };
  }
  if (error instanceof RailwayApiError) {
    return { ok: false, error: error.userMessage() };
  }
  return { ok: false, error: "Something went wrong. Please try again." };
}

export async function spinUp(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = spinUpSchema.safeParse({
    projectId: formData.get("projectId"),
    environmentId: formData.get("environmentId"),
    name: formData.get("name"),
    image: formData.get("image"),
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path[0];
    return {
      ok: false,
      error: issue.message,
      field: field === "name" || field === "image" ? field : undefined,
    };
  }

  const { projectId, environmentId, name, image } = parsed.data;

  try {
    const accessToken = await requireAccessToken();

    /*
     * Name collisions are the realistic double-submit failure: the same form posted
     * twice creates two identical services. Checking first is not airtight (nothing
     * short of a lock is), but it turns the common case into a clear message instead
     * of a duplicate container.
     */
    const managedName = toManagedName(name);
    const { containers } = await getProjectContainers(
      accessToken,
      projectId,
      environmentId,
    );
    if (containers.some((c) => c.rawName === managedName)) {
      return {
        ok: false,
        field: "name",
        error: `A container named "${name}" already exists here.`,
      };
    }

    await createContainer(accessToken, {
      projectId,
      environmentId,
      name: managedName,
      image,
    });

    revalidatePath("/dashboard");
    return { ok: true, message: `Spinning up ${name}` };
  } catch (error) {
    return toResult(error);
  }
}

export async function spinDown(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const projectId = String(formData.get("projectId") ?? "");
  const environmentId = String(formData.get("environmentId") ?? "");
  const serviceId = String(formData.get("serviceId") ?? "");

  if (!projectId || !environmentId || !serviceId) {
    return { ok: false, error: "Missing container reference." };
  }

  try {
    const accessToken = await requireAccessToken();

    /*
     * Re-derive ownership server-side. The client sends a service id and nothing else
     * is trusted: if the service was not created by this app, the delete is refused
     * here even though the user's own token would happily perform it.
     */
    const { containers } = await getProjectContainers(
      accessToken,
      projectId,
      environmentId,
    );
    const target = containers.find((c) => c.serviceId === serviceId);

    if (!target) {
      revalidatePath("/dashboard");
      return { ok: false, error: "That container no longer exists." };
    }
    if (!target.managed) {
      return {
        ok: false,
        error: "This service was not created here, so it cannot be destroyed here.",
      };
    }

    await destroyContainer(accessToken, serviceId);
    revalidatePath("/dashboard");
    return { ok: true, message: `Destroyed ${target.displayName}` };
  } catch (error) {
    return toResult(error);
  }
}

/** Cheap refresh for the client poll after a mutation settles. */
export async function refreshDashboard(): Promise<void> {
  revalidatePath("/dashboard");
}
