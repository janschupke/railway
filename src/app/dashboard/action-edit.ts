import "server-only";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/lib/action-result";
import { readServiceVariableNames, updateContainer } from "@/lib/railway/api";
import { log } from "@/lib/logger";
import { stripPrefix, toManagedName } from "@/lib/railway/managed";
import { presetFor } from "@/lib/presets";
import { resolveVariables } from "@/lib/railway/secrets";
import { containerEditSchema, pairVariableRows } from "@/lib/validation";
import { formField, formList, issueToResult, variableAudit } from "./action-form";
import { logLifecycle, withManagedContainer } from "./action-managed";

/**
 * Editing a container that already exists: its name, its image and its variables.
 *
 * The only verb that changes what a container *is* rather than whether it is running, and
 * the only one whose form carries more than three ids. Shape validation runs before the
 * ownership read, so a typo in the image reference costs no Railway round trip — the guard
 * still gates every mutation, because every mutation is inside its callback.
 */

/**
 * Change the name, image or environment of a container that already exists.
 *
 * The verb the app was missing. Every other lifecycle action stops, starts or destroys what
 * is already described; this is the only one that changes the description — which is why it
 * is the only one whose form carries more than three ids, and the only one that has to
 * decide what "unchanged" means.
 *
 * Shape validation happens *before* `withManagedContainer`, not inside it. A typo in the
 * image reference should cost nothing and point at the field that holds it; running the
 * ownership read first would spend a Railway round trip to tell someone they left the name
 * blank. The ownership check still gates every mutation, because every mutation is inside
 * the callback.
 */
export async function edit(formData: FormData): Promise<ActionResult> {
  const t = await getTranslations();

  const parsed = containerEditSchema.safeParse({
    projectId: formField(formData, "projectId"),
    environmentId: formField(formData, "environmentId"),
    serviceId: formField(formData, "serviceId"),
    name: formField(formData, "name"),
    image: formField(formData, "image"),
    variableKey: formList(formData, "variableKey"),
    variableValue: formList(formData, "variableValue"),
  });

  if (!parsed.success) {
    return issueToResult(t, parsed.error);
  }

  const { name, image, variableKey, variableValue } = parsed.data;
  const submitted = pairVariableRows({ variableKey, variableValue });

  return withManagedContainer("edit", formData, async (context) => {
    const { accessToken, projectId, environmentId, target } = context;

    /*
     * The rename goes through `toManagedName` like every other name this app writes, and
     * that single call is the whole of the rename safety property: a name that has lost
     * MANAGED_PREFIX is not a request shape, so there is nothing to validate and nothing to
     * refuse. The form posts the *display* name — prefix already stripped, which is what the
     * row shows — so this re-adds it. Handing it `target.rawName` would prefix twice.
     */
    const managedName = toManagedName(name);

    const takenByAnother = context.containers.some(
      (other) => other.serviceId !== target.serviceId && other.rawName === managedName,
    );
    if (managedName !== target.rawName && takenByAnother) {
      log.info("container.edit_rejected", {
        reason: "duplicate_name",
        project_id: projectId,
        environment_id: environmentId,
        service_name: managedName,
      });
      return { ok: false, field: "name", error: t("actions.duplicateName", { name }) };
    }

    /*
     * What the service holds now, read from Railway rather than accepted from the form.
     *
     * The client posts the rows it wants to end up with and says nothing about what was
     * there before — so "which variables am I deleting" is derived here, from the same class
     * of source ownership is. A browser that could name the prior set could name one that
     * included a variable it wanted removed.
     */
    const priorNames = await readServiceVariableNames(accessToken, {
      projectId,
      environmentId,
      serviceId: target.serviceId,
    });
    const prior = new Set(priorNames);
    const submittedNames = new Set(submitted.map((row) => row.name));

    /*
     * A blank value means two different things, and which one depends on whether the name is
     * already set — which is exactly why the prior set is read rather than sent.
     *
     *   - Blank on a row that already exists: leave it alone. The form never shows a stored
     *     value, so blank is what an untouched row looks like, and writing it back would
     *     erase every variable the user did not retype.
     *   - Blank on a row that does not: a new variable, minted if the catalog declares this
     *     name generated for this image and empty otherwise — the same rule spin-up applies,
     *     enforced by the same function.
     *
     * An existing row is therefore never re-minted, which matters most for the case it was
     * written for: reopening the editor on a postgres container and pressing Save must not
     * roll the database password.
     */
    const freshRows = submitted.filter((row) => !prior.has(row.name));
    /*
     * Guarded on there being a fresh row at all, and the guard is load-bearing rather than
     * an optimisation. `resolveVariables` reads an empty submitted list as "no editor on the
     * wire" — the pre-T-487 request shape — and answers with the catalog's whole default set,
     * minting every generated name in it. On spin-up that is exactly right. On an edit it
     * would roll the password of a live database every time someone saved a form whose only
     * change was elsewhere, which is what the e2e caught.
     */
    const { variables: minted, generated } =
      freshRows.length > 0
        ? resolveVariables(presetFor(image)?.variables, freshRows)
        : { variables: undefined, generated: false };
    const rewritten = Object.fromEntries(
      submitted
        .filter((row) => prior.has(row.name) && row.value !== "")
        .map((row) => [row.name, row.value]),
    );
    const variables = { ...minted, ...rewritten };
    const removeVariables = priorNames.filter((prev) => !submittedNames.has(prev));

    const updated = await updateContainer(accessToken, {
      projectId,
      environmentId,
      serviceId: target.serviceId,
      ...(managedName === target.rawName ? {} : { name: managedName }),
      ...(image === target.image ? {} : { image }),
      ...(Object.keys(variables).length > 0 ? { variables } : {}),
      ...(removeVariables.length > 0 ? { removeVariables } : {}),
    });

    /*
     * The audit trail for a change, with the same split `container.created` makes: names
     * the catalog owns are a closed set and are named, everything a person typed is
     * counted. `previous_name` and `previous_image` are here because this is the only
     * record anywhere of what the container used to be — Railway keeps no history of either.
     */
    logLifecycle("edit", context, {
      service_name: managedName,
      previous_name: target.rawName,
      image,
      previous_image: target.image,
      deployment_id: updated.deploymentId,
      outcome: updated.outcome,
      ...variableAudit(image, variables),
      variables_removed_count: removeVariables.length,
    });

    revalidatePath("/dashboard");

    const displayName = stripPrefix(managedName);

    /*
     * Both failures name the container and say what did land. The service has already
     * changed on these paths — that is what separates them from a throw — and a bare
     * "failed" would leave someone guessing whether to retype the whole form.
     */
    if (updated.outcome === "variables_failed") {
      return {
        ok: false,
        error: t("actions.editedButNotConfigured", { name: displayName }),
      };
    }
    if (updated.outcome === "deploy_failed") {
      return {
        ok: false,
        error: t("actions.editedButNotDeployed", { name: displayName }),
      };
    }
    if (updated.outcome === "unchanged") {
      return { ok: true, message: t("actions.editedNothing", { name: displayName }) };
    }

    return {
      ok: true,
      message: generated
        ? t("actions.editedWithCredentials", { name: displayName })
        : t("actions.edited", { name: displayName }),
    };
  });
}
