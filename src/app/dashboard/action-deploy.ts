import "server-only";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { log } from "@/lib/logger";
import type { ActionResult } from "@/lib/action-result";
import {
  createServiceDomain,
  deployService,
  listServiceDeployments,
  restartDeployment,
  rollbackDeployment,
  stopDeployment,
} from "@/lib/railway/api";
import { httpPortFor } from "@/lib/presets";
import { containerRollbackSchema } from "@/lib/validation";
import { formField } from "./action-form";
import { LIFECYCLE_EVENTS, logLifecycle, withManagedContainer } from "./action-managed";

/**
 * The lifecycle verbs that act on a deployment rather than on the service around it —
 * stop, restart, redeploy, rollback — and the one that gives a running container an address.
 *
 * All five are reversible, which is why none of them asks for a typed name. Four read the
 * deployment id off the target the guard resolved rather than off the form; `rollback` is the
 * exception, and resolves the posted one against Railway instead — see its docblock, and the
 * paragraph `withManagedContainer` devotes to it.
 */

/**
 * Stop and restart: the same action with one Railway call swapped.
 *
 * They were written out twice, identical down to the `nothingRunning` guard and the
 * `revalidatePath`, differing only in which mutation ran and which key names the success
 * message. `LIFECYCLE_EVENTS` already parameterises the verb for the log records, so the
 * message key was the only thing left holding two copies apart — and the client made this
 * same collapse for these exact three verbs, where `LifecycleActionDialog` is one component
 * rather than three.
 *
 * Redeploy is deliberately NOT folded in. It reads no deployment id off the target — it is
 * the one path that works on a service whose first deploy Railway refused, which is the row
 * a user most wants the control on — so it has a different precondition rather than a
 * different argument. See `redeployContainer`.
 *
 * **The mutation is branched on rather than passed in, and that is not a style choice.**
 * Taking `mutate` as a parameter removes the literal `stopDeployment(` and
 * `restartDeployment(` from this file, and both the byte-offset test this used to answer to
 * and `local/mutation-inside-ownership-guard` that replaced it are name-based: a rule looks
 * for a call whose callee is one of the mutations, and `mutate(deploymentId)` is not one.
 * The names would survive only as bare identifiers in an argument list, which no call-site
 * check can see. The first version of this helper turned a verified structural property
 * into an unverified one while every behavioural test stayed green.
 *
 * Worth stating plainly, because moving the check into the linter lifted the *layout*
 * constraint and not this one: the mutations may now live in any module, but a mutation
 * reached indirectly is still a mutation nothing is checking. Two lines of branch is the
 * price of the guard staying checkable, and it is worth paying on a path that changes
 * somebody else's infrastructure.
 */
export function deploymentAction(
  verb: "stop" | "restart",
  message: "actions.stopped" | "actions.restarted",
) {
  return (formData: FormData): Promise<ActionResult> =>
    withManagedContainer(verb, formData, async (context) => {
      const t = await getTranslations();
      const { deploymentId } = context.target;
      /*
       * Nothing to stop or restart is a state the UI does not offer — both controls are
       * gated on the row having a deployment — so this is the stale-page case, and it says
       * so rather than sending Railway an id it does not have.
       */
      if (!deploymentId) {
        return { ok: false, error: t("actions.nothingRunning") };
      }

      if (verb === "stop") await stopDeployment(context.accessToken, deploymentId);
      else await restartDeployment(context.accessToken, deploymentId);

      /*
       * The deployment id is recorded although restart does not change it — that is the
       * point of restart rather than redeploy, and a record naming it is what lets an
       * operator line this up with the log stream the user was watching at the time.
       */
      logLifecycle(verb, context, { deployment_id: deploymentId });

      revalidatePath("/dashboard");
      return {
        ok: true,
        message: t(message, { name: context.target.displayName }),
      };
    });
}

export async function redeploy(formData: FormData): Promise<ActionResult> {
  return withManagedContainer("redeploy", formData, async (context) => {
    const t = await getTranslations();
    /*
     * No deployment id needed, which is why this is the app's only redeploy path: a
     * service whose first deploy Railway refused has none, and it is exactly the row a
     * user most wants this control on. See deployService in lib/railway/api.ts.
     */
    const deploymentId = await deployService(context.accessToken, {
      serviceId: context.target.serviceId,
      environmentId: context.environmentId,
    });

    logLifecycle("redeploy", context, { deployment_id: deploymentId });

    revalidatePath("/dashboard");
    return {
      ok: true,
      message: t("actions.redeployed", { name: context.target.displayName }),
    };
  });
}

/**
 * Roll a container back to one of its own earlier deployments.
 *
 * The sixth lifecycle verb, and the only one whose request carries a fourth field. Every
 * other verb acts on the deployment the service is running now, which `withManagedContainer`
 * has already read off Railway; a rollback names one in the past, so the browser is the only
 * thing that knows which row was clicked and the id has to travel with the form.
 *
 * **Three refusals stand between that posted id and the mutation, and each answers a
 * different question.** The schema says it is shaped like a Railway identifier. The list read
 * — scoped by `context.target.serviceId`, which is Railway's answer to this request rather
 * than the form's — says it is one of *this* service's deployments, which is what makes a
 * forged id no more useful than a forged service id. And `canRollback` is Railway's own
 * judgement about whether the rollback would do anything, asked rather than guessed at, the
 * same way `canRedeploy` is.
 *
 * The list is `gqlPartial` and degrades to empty, so a refused read lands on the first of
 * those refusals. That is the direction it must fail in: no history means no member, means no
 * mutation.
 *
 * Rolling back to the deployment already running is refused separately, and for the user
 * rather than for safety — Railway would accept it, and the row would show a redeploy nobody
 * asked for. The panel does not offer it either; this is the stale-page case.
 *
 * What the response says about the result: nothing. `deploymentRollback` answers a Boolean,
 * and whether it reuses the deployment id or mints a new one is unobserved — see
 * DEPLOYMENT_ROLLBACK_MUTATION. `revalidatePath` and the row's own re-read are what settle it,
 * exactly as they do for redeploy.
 */
export async function rollback(formData: FormData): Promise<ActionResult> {
  return withManagedContainer("rollback", formData, async (context) => {
    const t = await getTranslations();

    const parsed = containerRollbackSchema.safeParse({
      projectId: context.projectId,
      environmentId: context.environmentId,
      serviceId: context.target.serviceId,
      deploymentId: formField(formData, "deploymentId"),
    });
    if (!parsed.success) {
      return { ok: false, error: t("actions.missingReference") };
    }

    const { deploymentId } = parsed.data;
    const name = context.target.displayName;

    if (deploymentId === context.target.deploymentId) {
      log.info(LIFECYCLE_EVENTS.rollback.skipped, {
        reason: "current",
        project_id: context.projectId,
        service_id: context.target.serviceId,
      });
      revalidatePath("/dashboard");
      return { ok: false, error: t("actions.rollbackIsCurrent", { name }) };
    }

    /*
     * `refused` is deliberately ignored here, unlike in the panel. A refused read and a
     * service with no history mean the same thing to this check — the posted id is not a
     * member of anything — and branching on the difference could only ever be a way of
     * treating one of them more permissively.
     */
    const { entries } = await listServiceDeployments(context.accessToken, {
      projectId: context.projectId,
      environmentId: context.environmentId,
      serviceId: context.target.serviceId,
    });
    const chosen = entries.find((entry) => entry.id === deploymentId);

    if (!chosen || !chosen.canRollback) {
      /*
       * At warn, and for the same reason the ownership refusal above it is: the panel only
       * renders a control for an entry Railway said yes to, so reaching here means a stale
       * page or a request nobody's browser composed. `reason` separates the two cases that
       * look identical from outside — an id this service has never had, and one it has that
       * Railway will not roll back to.
       *
       * The rejected id is not logged. It is caller-chosen and unbounded, which is the call
       * the stream route already makes about a deploymentId it refuses.
       */
      log.warn(LIFECYCLE_EVENTS.rollback.refused, {
        reason: chosen ? "not_rollbackable" : "not_in_service",
        project_id: context.projectId,
        service_id: context.target.serviceId,
      });
      return { ok: false, error: t("actions.rollbackUnavailable", { name }) };
    }

    await rollbackDeployment(context.accessToken, deploymentId);

    logLifecycle("rollback", context, {
      deployment_id: deploymentId,
      /*
       * The deployment being left, beside the one being returned to. A rollback is the one
       * verb where "what was running before" is not recoverable from the next record — the
       * row moves on and the previous id appears nowhere else in the trail.
       */
      from_deployment_id: context.target.deploymentId,
    });

    revalidatePath("/dashboard");
    return { ok: true, message: t("actions.rolledBack", { name }) };
  });
}

/**
 * Give an existing container a public address.
 *
 * The counterpart to the port field on the spin-up form, and it exists because that field
 * only ever gets one chance. A container spun up before this app could mint domains, one
 * whose port was left blank, one whose domain Railway refused at create time — all three are
 * rows with no address and, until this, no way to get one short of Railway's own dashboard.
 *
 * **The browser sends no port.** It posts the same three ids every lifecycle verb posts, and
 * the port is derived server-side from the image `withManagedContainer` read back from
 * Railway. That is the same rule the credential minting follows: what the catalog declares
 * for an image is granted, and what a request asks for is not. It also means this action
 * cannot be used to point a domain at an arbitrary port on a service the caller owns.
 *
 * For an image the catalog has never heard of, `targetPort` is omitted and Railway infers a
 * port from the running deployment. That inference is undocumented and is why the spin-up
 * form takes a port at all — a custom image says its port there. Stated in README
 * Limitations rather than hidden behind a control that sometimes picks wrong.
 */
export async function mintDomain(formData: FormData): Promise<ActionResult> {
  return withManagedContainer("domain", formData, async (context) => {
    const t = await getTranslations();
    const name = context.target.displayName;

    /*
     * Re-checked here even though the control is only rendered for a row with no address.
     * `serviceDomainCreate` mints a SECOND domain rather than refusing, so a stale page —
     * or two tabs pressing the button — would leave a service with two hostnames and a
     * row showing whichever sorted first. The check is on Railway's own answer, like the
     * ownership check above it.
     */
    if (context.target.url) {
      log.info(LIFECYCLE_EVENTS.domain.skipped, {
        reason: "exists",
        project_id: context.projectId,
        service_id: context.target.serviceId,
      });
      revalidatePath("/dashboard");
      return { ok: false, error: t("actions.domainExists", { name }) };
    }

    const targetPort = httpPortFor(context.target.image ?? "");

    const url = await createServiceDomain(context.accessToken, {
      environmentId: context.environmentId,
      serviceId: context.target.serviceId,
      ...(targetPort === undefined ? {} : { targetPort }),
    });

    /*
     * `target_port: 0` where the catalog knew nothing, so the record distinguishes "the
     * app chose 80" from "Railway chose". Those are different answers to the question an
     * operator asks when a domain points somewhere unexpected.
     */
    logLifecycle("domain", context, { target_port: targetPort ?? 0 });

    revalidatePath("/dashboard");
    return { ok: true, message: t("actions.domainCreated", { name, url }) };
  });
}
