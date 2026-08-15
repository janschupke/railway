"use server";

import type { ActionResult } from "@/lib/action-result";
import { withRequestScope } from "@/lib/log/request-scope";
import { create } from "@/app/dashboard/action-spin-up";
import { addEnvironment, addProject } from "@/app/dashboard/action-projects";
import { destroy, destroyMany } from "@/app/dashboard/action-destroy";
import { deploymentAction, mintDomain, redeploy } from "@/app/dashboard/action-deploy";
import { edit } from "@/app/dashboard/action-edit";

/**
 * Every Server Action this app has, and nothing else.
 *
 * The only `"use server"` file in the repo, and now only the surface: ten exports, each
 * opening a request scope and handing straight off to a module that is not itself an
 * action. What a verb actually does lives in `action-<verb>.ts` beside this.
 *
 * The shape is forced rather than chosen. A `"use server"` file may export only async
 * functions — Next's SWC transform refuses anything else — so a type, a constant or a
 * synchronous helper cannot sit beside these, and every one of the helpers below is one of
 * those. Next's own data-security guide prescribes the same split for the same reason:
 * thin actions delegating to modules that are not an action surface.
 *
 * This file was 1,574 lines, and what held it there was not the framework. Two tests
 * required it: one compared byte offsets to assert that every mutation appeared after the
 * ownership guard *in this file*, the other required nine of the ten `withRequestScope`
 * calls to stay in it. Both are lint rules now — `local/mutation-inside-ownership-guard`
 * and `local/action-scope-label` — and both state the property they were reaching for
 * rather than a fact about where the text sits, so they hold across all seven modules.
 *
 * What the split does not change: the scope label still has to match the export's own name,
 * every mutation still has to sit inside `withManagedContainer`'s callback or a function
 * that resolves ownership itself, and `trustInboundId` is still `true` on every one of
 * these because the proxy matcher covers `/dashboard` and overwrites the inbound header.
 */

export async function spinUp(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("spinUp", { trustInboundId: true }, () => create(formData));
}

export async function createProject(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("createProject", { trustInboundId: true }, () =>
    addProject(formData),
  );
}

export async function createEnvironment(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("createEnvironment", { trustInboundId: true }, () =>
    addEnvironment(formData),
  );
}

export async function spinDown(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("spinDown", { trustInboundId: true }, () =>
    destroy(formData),
  );
}

export async function spinDownMany(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("spinDownMany", { trustInboundId: true }, () =>
    destroyMany(formData),
  );
}

export async function stopContainer(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("stopContainer", { trustInboundId: true }, () =>
    deploymentAction("stop", "actions.stopped")(formData),
  );
}

export async function restartContainer(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("restartContainer", { trustInboundId: true }, () =>
    deploymentAction("restart", "actions.restarted")(formData),
  );
}

export async function redeployContainer(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("redeployContainer", { trustInboundId: true }, () =>
    redeploy(formData),
  );
}

export async function generateDomain(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("generateDomain", { trustInboundId: true }, () =>
    mintDomain(formData),
  );
}

export async function editContainer(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("editContainer", { trustInboundId: true }, () =>
    edit(formData),
  );
}
