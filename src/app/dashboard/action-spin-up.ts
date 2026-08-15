import "server-only";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireSession } from "@/lib/auth/server";
import type { ActionResult } from "@/lib/action-result";
import { runOnce, type Retainable } from "@/lib/idempotency";
import { createContainer } from "@/lib/railway/service-create";
import { log } from "@/lib/logger";
import { toManagedName } from "@/lib/railway/managed";
import { presetFor } from "@/lib/presets";
import { resolveVariables } from "@/lib/railway/secrets";
import { pairVariableRows, spinUpSchema } from "@/lib/validation";
import {
  formField,
  formList,
  issueToResult,
  toActionError,
  variableAudit,
} from "./action-form";

/**
 * Spin-up: the one action that brings a container into existence.
 *
 * Alone among the write paths in needing an idempotency key rather than an ownership
 * check — there is nothing to own yet, and the failure it guards against is creating two
 * containers rather than acting on someone else's (ADR-12).
 */

export async function create(formData: FormData): Promise<ActionResult> {
  const t = await getTranslations();

  const parsed = spinUpSchema.safeParse({
    projectId: formField(formData, "projectId"),
    environmentId: formField(formData, "environmentId"),
    name: formField(formData, "name"),
    image: formField(formData, "image"),
    port: formField(formData, "port"),
    region: formField(formData, "region"),
    replicas: formField(formData, "replicas"),
    cpu: formField(formData, "cpu"),
    memory: formField(formData, "memory"),
    restartPolicy: formField(formData, "restartPolicy"),
    restartRetries: formField(formData, "restartRetries"),
    startCommand: formField(formData, "startCommand"),
    variableKey: formList(formData, "variableKey"),
    variableValue: formList(formData, "variableValue"),
    idempotencyKey: formField(formData, "idempotencyKey"),
  });

  if (!parsed.success) {
    return issueToResult(t, parsed.error);
  }

  const { projectId, environmentId, name, idempotencyKey } = parsed.data;

  try {
    const session = await requireSession();

    /*
     * Single-flight, by the key the form minted for this submission.
     *
     * What stood here was a name lookup — the container list, read in full, before every
     * create — and its own comment conceded that reading a list is not holding a lock.
     * Two submissions a millisecond apart both read a list without the name in it and
     * both created a container. It also made a spin-up four Railway round trips; it is
     * three now.
     *
     * Keyed by user as well as by key, so one person's submission can neither claim nor
     * observe another's. See `entries` in lib/idempotency.ts for what is retained, for
     * how long, and for the one case this deliberately does not cover.
     */
    const { value, replayed } = await runOnce(
      `${session.user.id}:${idempotencyKey}`,
      () => attempt(session.accessToken, parsed.data),
    );

    if (replayed) {
      /*
       * Part of the audit trail rather than a counter, for the same reason
       * `container.created` is: this request told someone a container exists without
       * creating one, and a record of who was told what belongs next to the record of
       * what was made.
       */
      log.info("container.create_replayed", {
        project_id: projectId,
        environment_id: environmentId,
        service_name: toManagedName(name),
      });
      /*
       * Revalidation is attached to the request that responds, so the one this caller is
       * on has had none — the create happened inside somebody else's. It matters least on
       * the success path, where the form refreshes itself, and most on the two branches
       * that created a service and then failed: those do not refresh, and without this the
       * caller would be told to destroy an orphan it cannot see.
       */
      revalidatePath("/dashboard");
    }

    return value;
  } catch (error) {
    return toActionError(t, error);
  }
}

type SpinUpInput = ReturnType<typeof spinUpSchema.parse>;

/**
 * One real attempt at creating the container.
 *
 * Split from `create` so it can be handed to `runOnce` as the thing that runs at most
 * once. The return type is the interesting half: `retain` says whether a later submission
 * carrying the same key may be given this answer instead of making its own container, and
 * only this function is in a position to know. Every path that reaches a `return` here has
 * left a service on Railway — they are the same three the `container.created` line below
 * covers — so all three retain. Everything else throws, and a rejection is released
 * immediately, because a create Railway refused has to stay retryable.
 */
async function attempt(
  accessToken: string,
  data: SpinUpInput,
): Promise<Retainable<ActionResult>> {
  /*
   * Resolved here rather than passed in from `create`. next-intl caches per request, so
   * the second call is free, and taking it as a parameter would mean naming the type
   * `getTranslations()` actually returns — which is wider than the `Translator` alias
   * above, since that one is the namespaced overload.
   */
  const t = await getTranslations();
  const {
    projectId,
    environmentId,
    name,
    image,
    port,
    region,
    replicas,
    cpu,
    memory,
    restartPolicy,
    restartRetries,
    startCommand,
    variableKey,
    variableValue,
  } = data;

  const submittedVariables = pairVariableRows({ variableKey, variableValue });

  const managedName = toManagedName(name);

  /*
   * The environment the service is created with: what the person typed, with the
   * catalog's own defaults filled in for anything they left blank.
   *
   * This action accepts user-supplied environment, and until T-487 it did not. The old
   * property — "the client sends no preset id and no variables, so no request shape
   * injects arbitrary environment" — was real, and it is gone deliberately: a spin-up
   * form that cannot set a variable is a form that cannot start most images. It is
   * replaced rather than deleted, by three bounds that do not overlap:
   *
   *   - `spinUpSchema` bounds the SHAPE — name charset, name and value lengths, the row
   *     count, the total size, duplicates, and the RAILWAY_ namespace Railway sets
   *     itself. A refused row is a form error; no mutation is attempted.
   *   - `resolveVariables` bounds the AUTHORITY. It is still the only thing in the app
   *     that mints a credential, it mints only for a name the CATALOG declares generated
   *     for this image, and a generated value is returned to no browser on any path.
   *     "Generate me a secret" is not a request shape; leaving blank a row the catalog
   *     owns is.
   *   - The log line below bounds the RECORD — see there.
   *
   * The blast radius is unchanged, and that is what makes the trade defensible: every
   * mutation carries the requester's own token, so injecting environment means injecting
   * it into a service they asked this app to create in a project their own Railway grant
   * already reaches. See SECURITY.md, "Input surfaces".
   */
  const preset = presetFor(image);
  const { variables, generated } = resolveVariables(
    preset?.variables,
    submittedVariables,
  );

  /*
   * The resource controls, in the two shapes Railway's two mutations take. Absent members
   * are absent rather than null: `createContainer` sends only what is here, and an empty
   * object issues no request at all.
   *
   * `restartRetries` is dropped unless the policy is ON_FAILURE, which is the only policy
   * the number means anything under. The form disables that field for the other two and a
   * disabled input posts nothing, so this is unreachable from a browser — and it is a drop
   * rather than a refusal because a request carrying a retry count for a policy that ignores
   * it has said nothing wrong. Refusing it would be this app guessing stricter than the
   * platform, which is the failure mode lib/validation.ts warns about twice.
   */
  const settings = {
    ...(region === undefined ? {} : { region }),
    ...(replicas === undefined ? {} : { replicas }),
    ...(restartPolicy === undefined ? {} : { restartPolicy }),
    ...(restartRetries === undefined || restartPolicy !== "ON_FAILURE"
      ? {}
      : { restartRetries }),
    ...(startCommand === undefined ? {} : { startCommand }),
  };
  const limits = {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory }),
  };

  /*
   * Scoped to this one call, not to the whole action.
   *
   * `create`'s catch also covers the session read, where no create was ever attempted and
   * an event named `container.create_failed` would be a lie. Here, a throw means
   * `serviceCreate` itself was refused: nothing exists on Railway, the record is of an
   * attempt, and the rethrow is also what releases the idempotency key so the person can
   * press the button again. Every outcome that does leave a service behind returns
   * instead, is logged as `container.created` below, and retains.
   */
  let created;
  try {
    created = await createContainer(accessToken, {
      projectId,
      environmentId,
      name: managedName,
      image,
      ...(variables ? { variables } : {}),
      /*
       * Passed straight through, and it is the one field on this call the browser chose the
       * value of. The catalog seeded the form's field and the person could overwrite it,
       * which is deliberate — a custom image is exactly the case the catalog cannot answer
       * for — and `spinUpSchema` has already bounded it to an integer in the port range.
       * Unlike a variable value it reaches no environment and no shell: its only
       * destination is `ServiceDomainCreateInput.targetPort`.
       */
      ...(port === undefined ? {} : { targetPort: port }),
      settings,
      limits,
    });
  } catch (error) {
    // Rethrown immediately: `describeActionError` still owns what the user is told. This
    // adds the context an `action` line cannot have — which name, which image, where —
    // and warn because a refused create is an anomaly, not the ordinary path.
    log.warn("container.create_failed", {
      project_id: projectId,
      environment_id: environmentId,
      service_name: managedName,
      image,
      error,
    });
    throw error;
  }

  /*
   * The audit trail. This action creates billable infrastructure, and once a service is
   * deleted Railway retains no record that it existed — so without this line there is
   * nothing anywhere that says who created what, from which image, and when. `image` is
   * user-supplied but validated and bounded at LIMITS.IMAGE_REF_MAX, and it is the
   * single most useful field in the record. The field set is deliberately the shape a
   * database table would take, so promoting this to one later is a parse rather than a
   * re-instrumentation.
   *
   * Reached on every path where a service now exists, running or not — which is what
   * makes it an audit trail rather than a success counter. `outcome` says which, so a
   * record of an orphan is not indistinguishable from a record of a live container.
   */
  log.info("container.created", {
    project_id: projectId,
    environment_id: environmentId,
    service_name: managedName,
    image,
    service_id: created.serviceId,
    deployment_id: created.deploymentId,
    outcome: created.outcome,
    /*
     * Split in two, because the two halves have different cardinality.
     *
     * Preset-derived names come from a closed catalog, so naming them keeps the audit
     * trail readable and keeps the label bounded. User-supplied names are neither closed
     * nor bounded, and are attacker-chosen in exactly the way the rejected deploymentId
     * is — so a count carries the diagnostic content instead, the same trade `id_length`
     * makes on the stream route. Values, of either origin, are written nowhere at any
     * level; the logger's scalar-only field type is what makes that hard to get wrong.
     *
     * The consequence, stated because it is a real loss: this record no longer says what
     * environment a service was actually created with. SECURITY.md says so too.
     */
    ...variableAudit(image, variables),
    /*
     * Whether this container was put on the public internet, and on which port. Part of the
     * audit trail rather than diagnostics: "reachable from anywhere" is the single most
     * consequential thing this action can do to a service, and a record that says a
     * container was created without saying that would be describing a different container.
     *
     * The port, not the hostname. Railway derives the hostname from the service name, which
     * is already in this record, so the URL would be a second copy of a value above — and
     * the port is the half that says what the domain actually points at.
     */
    target_port: port ?? 0,
    domain_created: created.url !== null,
    /*
     * How big the thing that was created is, which is new to this record and is the half
     * that costs money.
     *
     * Replicas times vCPU times memory is the first thing this app lets anyone set that
     * multiplies the bill, and the app can never say what that came to: the usage readout is
     * a workspace figure — see WorkspaceSpend — and Railway keeps no record a service existed
     * once it is destroyed. So this line is the only place anywhere that says a container was
     * asked to be five copies of eight gigabytes. Zero reads as "not asked for", which is
     * what a blank field means everywhere else on this form.
     *
     * The start command's length rather than the command, on the split the variable names
     * above already make: everything else here is closed or bounded, and that one is free
     * text somebody typed.
     */
    region: region ?? "",
    replicas: replicas ?? 0,
    vcpus: cpu ?? 0,
    memory_gb: memory ?? 0,
    restart_policy: restartPolicy ?? "",
    restart_retries: settings.restartRetries ?? -1,
    start_command_length: startCommand?.length ?? 0,
  });

  revalidatePath("/dashboard");

  /*
   * Every failure names the container. The service exists and is destroyable; saying only
   * "failed" would leave the user hunting for something they were not told had been
   * created — and on the deploy branch it is a billable orphan they would have no name
   * to search Railway for. The sentences differ because the remedies differ: refused
   * variables are a preset problem, a refused deploy is Railway's.
   *
   * Retained, all of them, and that is the point of saying so per-branch rather than
   * once at the end: a service exists, so a repeat of this submission must be told about
   * that one rather than make a second.
   */
  if (created.outcome === "volume_failed") {
    /*
     * The one branch where NOT deploying is the feature rather than damage control. This
     * image keeps state, Railway refused the volume, and a container that came up here would
     * take the user's data and lose it — which is the defect T-491 exists to remove. The
     * sentence says the container exists and is not running, because both halves are what
     * the person has to act on.
     */
    return {
      value: { ok: false, error: t("actions.createdButNoVolume", { name }) },
      retain: true,
    };
  }
  if (created.outcome === "settings_failed") {
    return {
      value: { ok: false, error: t("actions.createdButNoSettings", { name }) },
      retain: true,
    };
  }
  if (created.outcome === "limits_failed") {
    /*
     * Its own sentence rather than a share of the one above, because the likely cause is
     * different and so is the remedy: this is usually the plan behind the token refusing a
     * service that size, which is fixed by asking for less rather than by asking again.
     * Said as "usually" — the app cannot read the plan, and asserting a cause it cannot
     * check would be the same mistake as rendering upstream failure text.
     */
    return {
      value: { ok: false, error: t("actions.createdButNoLimits", { name }) },
      retain: true,
    };
  }
  if (created.outcome === "variables_failed") {
    return {
      value: { ok: false, error: t("actions.createdButNotConfigured", { name }) },
      retain: true,
    };
  }
  if (created.outcome === "deploy_failed") {
    return {
      value: { ok: false, error: t("actions.createdButNotDeployed", { name }) },
      retain: true,
    };
  }

  /*
   * Four whole sentences over two independent facts, rather than one sentence with pieces
   * bolted on.
   *
   * The two are genuinely independent — a postgres mints a credential and gets no address,
   * an nginx gets an address and mints nothing, a rabbitmq does both — so something has to
   * carry the combinations. Composing them from fragments at runtime is the version that
   * cannot be translated: word order, and whether the second clause is even a separate
   * sentence, are decisions the catalog has to be allowed to make per language. See
   * .ai/rules/i18n.md.
   *
   * `generated` is gated on what was MINTED rather than on whether any variable was set: a
   * user who typed their own password has their own copy, and sending them to Railway to
   * read it back would be telling them to look up something they already know.
   *
   * `created.url` may be null on a spin-up that asked for a domain — Railway refused it, and
   * `railway.domain_failed` has the record. The user is told about the container rather than
   * about the missing address, because the container is what they asked for and the row now
   * offers the control that fixes the rest.
   */
  const url = created.url;
  return {
    value: {
      ok: true,
      message: url
        ? generated
          ? t("actions.spinningUpWithCredentialsAtUrl", { name, url })
          : t("actions.spinningUpAtUrl", { name, url })
        : generated
          ? t("actions.spinningUpWithCredentials", { name })
          : t("actions.spinningUp", { name }),
    },
    retain: true,
  };
}
