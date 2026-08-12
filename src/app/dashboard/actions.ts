"use server";

import { revalidatePath } from "next/cache";
import { requireAccessToken } from "@/lib/auth/server";
import { isField, toActionError, type ActionResult } from "@/lib/action-result";
import {
  createContainer,
  destroyContainer,
  getProjectContainers,
} from "@/lib/railway/api";
import { toManagedName } from "@/lib/railway/managed";
import { spinDownSchema, spinUpSchema } from "@/lib/validation";

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
    if (!issue) return { ok: false, error: "Check the form and try again." };
    const field = issue.path[0];
    return {
      ok: false,
      error: issue.message,
      ...(isField(field) ? { field } : {}),
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
    return toActionError(error);
  }
}

export async function spinDown(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = spinDownSchema.safeParse({
    projectId: formData.get("projectId"),
    environmentId: formData.get("environmentId"),
    serviceId: formData.get("serviceId"),
  });
  if (!parsed.success) {
    return { ok: false, error: "Missing container reference." };
  }

  const { projectId, environmentId, serviceId } = parsed.data;

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
    return toActionError(error);
  }
}
