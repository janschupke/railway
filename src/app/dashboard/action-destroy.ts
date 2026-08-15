import "server-only";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAccessToken } from "@/lib/auth/server";
import type { ActionResult } from "@/lib/action-result";
import { getProjectContainers } from "@/lib/railway/projects";
import { destroyContainer } from "@/lib/railway/service-lifecycle";
import { deleteVolume, getEnvironmentVolumes } from "@/lib/railway/volumes";
import { log } from "@/lib/logger";
import { SessionExpiredError } from "@/lib/auth/refresh";
import { containerBulkActionSchema } from "@/lib/validation";
import type { Container, ContainerVolume } from "@/lib/railway/types";
import { formField, formList, issueToResult, toActionError } from "./action-form";
import {
  LIFECYCLE_EVENTS,
  logLifecycle,
  resolveManagedTarget,
  withManagedContainer,
} from "./action-managed";

/**
 * Destroying containers, one or several, and deciding what happens to their data.
 *
 * One and several stay together because they share `destroyManagedContainer`, which is the
 * only place in the app that sends `serviceDelete` or `volumeDelete` — and the part that
 * must not differ between destroying one container and destroying six.
 *
 * The batch resolves ownership per id against a list it read once, rather than opening the
 * guard per service. What refuses a forged id there is the type: `ManagedResolution` is a
 * discriminated union and `.target` does not exist on the branch where `managed` is false.
 */

/**
 * Destroying one container that ownership has already cleared, and its volume with it.
 *
 * The mechanism only. Which containers, whether the box was ticked and what the user is told
 * afterwards all belong to the two actions below — this is the part that must not differ
 * between destroying one and destroying six, and the only place in the app that sends either
 * of these two mutations.
 *
 * `volume` is passed in rather than looked up, because a batch reads the environment's
 * volumes once for all of its services and a single destroy reads them for its one.
 */
async function destroyManagedContainer(
  accessToken: string,
  context: { projectId: string; environmentId: string; target: Container },
  volume: ContainerVolume | undefined,
  deleteData: boolean,
): Promise<{ volumeDeleted: boolean }> {
  await destroyContainer(accessToken, context.target.serviceId);

  /*
   * After the service, never before.
   *
   * Railway refuses to delete a volume that is still mounted on a live service, so the
   * order is forced — and it is also the order that fails safe. Service first leaves,
   * at worst, an orphan volume the user can see and delete in Railway's own dashboard;
   * volume first would, at worst, wipe the data under a container that is still running.
   */
  let volumeDeleted = false;
  if (volume && deleteData) {
    await deleteVolume(accessToken, volume.volumeId);
    volumeDeleted = true;
  }

  /*
   * The other half of the audit trail. After this, Railway has no record the container
   * existed — and `volume_deleted` is the only place any record of the data's fate
   * survives, which is why it is written on both branches rather than only when true.
   *
   * One line per service, in the batch case as much as the single one. A bulk destroy that
   * wrote one record naming six services would be the moment this stopped being an audit
   * trail and started being a counter.
   */
  logLifecycle("destroy", context, {
    volume_deleted: volumeDeleted,
    volume_id: volume?.volumeId ?? null,
  });

  return { volumeDeleted };
}

export async function destroy(formData: FormData): Promise<ActionResult> {
  return withManagedContainer("destroy", formData, async (context) => {
    /*
     * Resolved here rather than handed down from the helper, for the reason `attempt`
     * gives one screen up: next-intl caches per request so the second call is free, and
     * passing it would mean naming the type `getTranslations()` actually returns — which
     * is wider than the `Translator` alias, since that one is the namespaced overload.
     */
    const t = await getTranslations();
    const name = context.target.displayName;

    /*
     * What the dialog's checkbox asked for — a request, not an instruction.
     *
     * The browser posts a boolean and a service id, and nothing else about the volume:
     * not its id, not whether one exists. Both of those are read back from Railway below,
     * for the same reason ownership and the deployment id are. A form that could name the
     * volume to delete would be a form that could name somebody else's.
     */
    const deleteData = formField(formData, "deleteData") === "on";

    /*
     * Read BEFORE the service is deleted, and unconditionally — not only when the box was
     * ticked.
     *
     * Before, because `volumeInstance.serviceId` is what ties a volume to the container the
     * user is looking at. Railway keeps answering that field after the service is gone, but
     * this app would have nothing left to check it against: `withManagedContainer`'s
     * ownership proof is the service's own name. Reading first keeps the association one
     * Railway confirms rather than one this app remembers.
     *
     * Unconditionally, because the answer decides which sentence is TRUE rather than which
     * one was asked for. Reading only when the box was ticked meant an unticked destroy
     * knew of no volume and fell through to the plain "Destroyed db" — so the one outcome
     * that leaves a charge behind was the one that said nothing about it, which is the
     * opposite of what the sentence exists for. It costs one read on a path that already
     * reads the whole container list.
     *
     * Degrades to `{}`: EnvironmentVolumes is in DEGRADING_OPERATIONS, so a refused read
     * finds no volume and the plain sentence is used. That is the honest answer rather than
     * a cautious one — with the read refused this app does not know a volume exists, and
     * claiming one was kept would be a statement it cannot support. docs/limitations.md says
     * where that leaves the user.
     */
    const volumes = await getEnvironmentVolumes(
      context.accessToken,
      context.environmentId,
    );
    const volume = volumes[context.target.serviceId];

    const { volumeDeleted } = await destroyManagedContainer(
      context.accessToken,
      context,
      volume,
      deleteData,
    );

    revalidatePath("/dashboard");
    return {
      ok: true,
      /*
       * Three sentences for three outcomes, and each is keyed on what HAPPENED rather than
       * on what was asked for — the user cannot check any of this from here once the row
       * is gone.
       *
       * "Kept" is stated rather than implied: a volume left behind is billable storage
       * this app will never show again, since it lists containers and that volume no
       * longer has one. Silence there would be the app declining to mention a charge it
       * caused, which is precisely what the middle branch exists to prevent.
       */
      message: volumeDeleted
        ? t("actions.destroyedWithVolume", { name })
        : volume
          ? t("actions.destroyedVolumeKept", { name })
          : t("actions.destroyed", { name }),
    };
  });
}

export async function destroyMany(formData: FormData): Promise<ActionResult> {
  const t = await getTranslations();
  const events = LIFECYCLE_EVENTS.destroy;

  const parsed = containerBulkActionSchema.safeParse({
    projectId: formField(formData, "projectId"),
    environmentId: formField(formData, "environmentId"),
    serviceId: formList(formData, "serviceId"),
  });
  if (!parsed.success) {
    // The count ceiling is the one rule here a person can be told something useful about;
    // everything else this schema refuses is a request no browser produces. Every field is
    // a hidden input, so there is nothing on screen to attribute to.
    return issueToResult(t, parsed.error, {
      attribute: false,
      fallback: "actions.missingReference",
    });
  }

  const { projectId, environmentId, serviceId: serviceIds } = parsed.data;
  const deleteData = formField(formData, "deleteData") === "on";

  try {
    const accessToken = await requireAccessToken();

    // One read for the batch, uncancellable, for the reasons `withManagedContainer` states.
    const { containers } = await getProjectContainers(
      accessToken,
      projectId,
      environmentId,
    );
    const volumes = await getEnvironmentVolumes(accessToken, environmentId);

    /*
     * Deduplicated, because two entries naming the same service would destroy it once and
     * then report a failure destroying it again — a batch that lies about its own outcome
     * on a request the browser cannot send but a hand-written form can.
     */
    let destroyed = 0;
    let failed = 0;
    for (const id of new Set(serviceIds)) {
      const resolution = resolveManagedTarget(containers, id);

      if (!resolution.managed) {
        failed += 1;
        const record = { project_id: projectId, service_id: id };
        if (resolution.reason === "gone") {
          log.info(events.skipped, { reason: "gone", ...record });
        } else {
          log.warn(events.refused, { reason: "unmanaged", ...record });
        }
        continue;
      }

      const context = { projectId, environmentId, target: resolution.target };
      try {
        await destroyManagedContainer(
          accessToken,
          context,
          volumes[resolution.target.serviceId],
          deleteData,
        );
        destroyed += 1;
      } catch (error) {
        /*
         * Recorded and counted rather than rethrown. The services already destroyed are
         * gone whatever happens next, so abandoning the batch here would end the request
         * with an error message and no account of them at all.
         *
         * A session that expired mid-batch is the one exception: every remaining call would
         * fail the same way, and the user needs the sentence that says why rather than
         * "6 of 6 could not be destroyed".
         */
        if (error instanceof SessionExpiredError) throw error;
        failed += 1;
        log.warn(events.failed, {
          project_id: projectId,
          service_id: resolution.target.serviceId,
          service_name: resolution.target.rawName,
          error,
        });
      }
    }

    revalidatePath("/dashboard");

    const total = destroyed + failed;
    if (destroyed === 0) {
      return { ok: false, error: t("actions.destroyedNone", { count: total }) };
    }
    return {
      ok: true,
      /*
       * The shortfall is named rather than rounded away. Every reason a service was left
       * behind — gone, not ours, refused by Railway — leaves the row on the page after the
       * refresh, so a sentence claiming all six went would be contradicted by the list
       * underneath it within the second.
       */
      message:
        failed === 0
          ? t("actions.destroyedMany", { count: destroyed })
          : t("actions.destroyedSome", { count: destroyed, total }),
    };
  } catch (error) {
    return toActionError(t, error);
  }
}
