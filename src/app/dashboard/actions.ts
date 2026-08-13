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
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { toManagedName } from "@/lib/railway/managed";
import { presetFor } from "@/lib/presets";
import { resolveVariables } from "@/lib/railway/secrets";
import {
  VALIDATION_KEYS,
  VALIDATION_VALUES,
  spinDownSchema,
  spinUpSchema,
} from "@/lib/validation";
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
 * A FormData field as a string.
 *
 * `formData.get` returns null for a field the browser never sent, and null fails zod's
 * type check ahead of the rule that carries the catalog key. Coercing here means the
 * `.min(1)` message is the one that fires, which is the message written for this case.
 */
const formField = (formData: FormData, name: string): string =>
  String(formData.get(name) ?? "");

export async function spinUp(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("spinUp", { trustInboundId: true }, () => create(formData));
}

async function create(formData: FormData): Promise<ActionResult> {
  const t = await getTranslations();

  const parsed = spinUpSchema.safeParse({
    projectId: formField(formData, "projectId"),
    environmentId: formField(formData, "environmentId"),
    name: formField(formData, "name"),
    image: formField(formData, "image"),
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
      log.info("container.create_rejected", {
        reason: "duplicate_name",
        project_id: projectId,
        environment_id: environmentId,
        service_name: managedName,
      });
      return {
        ok: false,
        field: "name",
        error: t("actions.duplicateName", { name }),
      };
    }

    /*
     * Variables are derived from the *submitted image string*, server-side.
     *
     * The client never sends a preset id and never sends variables, so there is no
     * request shape in which a caller can inject arbitrary environment into a service.
     * The whole attack surface is the image reference, which IMAGE_PATTERN already
     * bounds. That is why the preset catalog is a shared module rather than a client
     * constant — see SECURITY.md.
     */
    const preset = presetFor(image);
    const variables = resolveVariables(preset?.variables);

    const created = await createContainer(accessToken, {
      projectId,
      environmentId,
      name: managedName,
      image,
      ...(variables ? { variables } : {}),
    });

    /*
     * The audit trail. This action creates billable infrastructure, and once a service is
     * deleted Railway retains no record that it existed — so without this line there is
     * nothing anywhere that says who created what, from which image, and when. `image` is
     * user-supplied but validated and bounded at LIMITS.IMAGE_REF_MAX, and it is the
     * single most useful field in the record. The field set is deliberately the shape a
     * database table would take, so promoting this to one later is a parse rather than a
     * re-instrumentation.
     */
    log.info("container.created", {
      project_id: projectId,
      environment_id: environmentId,
      service_name: managedName,
      image,
      service_id: created.serviceId,
      deployment_id: created.deploymentId,
      // Names only, never values — they are generated credentials. The logger's own
      // scalar-only field type is what makes that hard to get wrong. See secrets.ts.
      variable_names: variables ? Object.keys(variables).join(",") : "",
    });

    revalidatePath("/dashboard");

    if (!created.configured) {
      // The service exists and is destroyable; saying only "failed" would leave the user
      // hunting for something they were not told had been created.
      return { ok: false, error: t("actions.createdButNotConfigured", { name }) };
    }

    return {
      ok: true,
      message: variables
        ? t("actions.spinningUpWithCredentials", { name })
        : t("actions.spinningUp", { name }),
    };
  } catch (error) {
    const { key, values } = describeActionError(error);
    return { ok: false, error: asTranslate(t)(key as MessageKey, values) };
  }
}

export async function spinDown(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("spinDown", { trustInboundId: true }, () =>
    destroy(formData),
  );
}

async function destroy(formData: FormData): Promise<ActionResult> {
  const t = await getTranslations();

  const parsed = spinDownSchema.safeParse({
    projectId: formField(formData, "projectId"),
    environmentId: formField(formData, "environmentId"),
    serviceId: formField(formData, "serviceId"),
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
      log.info("container.destroy_skipped", {
        reason: "gone",
        project_id: projectId,
        service_id: serviceId,
      });
      revalidatePath("/dashboard");
      return { ok: false, error: t("actions.gone") };
    }
    if (!target.managed) {
      /*
       * The ownership boundary refusing a request, at warn because it should never
       * happen through the UI — the destroy control is only rendered for managed
       * services. Silent, this was indistinguishable from a UI bug; named, it is the
       * difference between a stale page and someone posting service ids by hand.
       */
      log.warn("container.destroy_refused", {
        reason: "unmanaged",
        project_id: projectId,
        service_id: serviceId,
      });
      return { ok: false, error: t("actions.notManaged") };
    }

    await destroyContainer(accessToken, serviceId);

    // The other half of the audit trail. After this, Railway has no record it existed.
    log.info("container.destroyed", {
      project_id: projectId,
      environment_id: environmentId,
      service_id: serviceId,
      service_name: target.rawName,
    });

    revalidatePath("/dashboard");
    return { ok: true, message: t("actions.destroyed", { name: target.displayName }) };
  } catch (error) {
    const { key, values } = describeActionError(error);
    return { ok: false, error: asTranslate(t)(key as MessageKey, values) };
  }
}
