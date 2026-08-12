"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAccessToken } from "@/lib/auth/server";
import { describeActionError, isField, type ActionResult } from "@/lib/action-result";
import {
  createContainer,
  destroyContainer,
  getProjectContainers,
} from "@/lib/railway/api";
import { toManagedName } from "@/lib/railway/managed";
import { VALIDATION_VALUES, spinDownSchema, spinUpSchema } from "@/lib/validation";
import type { MessageKey, Translate } from "@/lib/messages";

/**
 * Server Actions resolve copy themselves.
 *
 * The result is rendered by a toast the client already owns, so shipping a key back and
 * translating there would mean the client needing the error namespace loaded for
 * messages it may never show.
 */
type Translator = Awaited<ReturnType<typeof getTranslations>>;

const asTranslate =
  (t: Translator): Translate =>
  (key, values) =>
    t(key as Parameters<Translator>[0], values as never);

/** Zod issues carry catalog keys as their `message`; some also interpolate a limit. */
function messageForIssue(t: Translator, key: string): string {
  const values = VALIDATION_VALUES[key];
  return t(key as Parameters<Translator>[0], values as never);
}

export async function spinUp(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations();

  const parsed = spinUpSchema.safeParse({
    projectId: formData.get("projectId"),
    environmentId: formData.get("environmentId"),
    name: formData.get("name"),
    image: formData.get("image"),
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) return { ok: false, error: t("actions.invalidForm") };
    const field = issue.path[0];
    return {
      ok: false,
      error: messageForIssue(t, issue.message),
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
        error: t("actions.duplicateName", { name }),
      };
    }

    await createContainer(accessToken, {
      projectId,
      environmentId,
      name: managedName,
      image,
    });

    revalidatePath("/dashboard");
    return { ok: true, message: t("actions.spinningUp", { name }) };
  } catch (error) {
    const { key, values } = describeActionError(error);
    return { ok: false, error: asTranslate(t)(key as MessageKey, values) };
  }
}

export async function spinDown(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations();

  const parsed = spinDownSchema.safeParse({
    projectId: formData.get("projectId"),
    environmentId: formData.get("environmentId"),
    serviceId: formData.get("serviceId"),
  });
  if (!parsed.success) {
    return { ok: false, error: t("actions.missingReference") };
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
      return { ok: false, error: t("actions.gone") };
    }
    if (!target.managed) {
      return { ok: false, error: t("actions.notManaged") };
    }

    await destroyContainer(accessToken, serviceId);
    revalidatePath("/dashboard");
    return { ok: true, message: t("actions.destroyed", { name: target.displayName }) };
  } catch (error) {
    const { key, values } = describeActionError(error);
    return { ok: false, error: asTranslate(t)(key as MessageKey, values) };
  }
}
