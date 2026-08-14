"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAccessToken, requireSession } from "@/lib/auth/server";
import { describeActionError, isField, type ActionResult } from "@/lib/action-result";
import { runOnce, type Retainable } from "@/lib/idempotency";
import {
  createContainer,
  deployService,
  destroyContainer,
  getProjectContainers,
  restartDeployment,
  stopDeployment,
  /*
   * Aliased because the exported actions below are the same two verbs. The repo's other
   * actions dodge this by being named for the UI rather than the API — spinUp calls
   * createContainer — and there is no such second name for "create a project" that is not
   * a euphemism.
   */
  createEnvironment as createEnvironmentOnRailway,
  createProject as createProjectOnRailway,
} from "@/lib/railway/api";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { toManagedName } from "@/lib/railway/managed";
import { presetFor } from "@/lib/presets";
import { resolveVariables } from "@/lib/railway/secrets";
import {
  VALIDATION_KEYS,
  VALIDATION_VALUES,
  containerActionSchema,
  environmentCreateSchema,
  projectCreateSchema,
  spinUpSchema,
} from "@/lib/validation";
import type { MessageKey, Translate } from "@/lib/messages";
import type { Container } from "@/lib/railway/types";

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

/**
 * A repeated FormData field, as strings.
 *
 * `getAll` rather than `get`: the environment editor posts one entry per row under a
 * single name, and FormData preserves per-name insertion order, so index i of the two
 * lists is one row without an index ever being written down.
 *
 * A non-string entry is a hand-crafted request rather than anything a browser sends, and
 * it has no honest coercion — `""` is what asks the catalog for a generated credential, so
 * coercing to it would turn a `File` part into a request for a secret. It becomes a byte
 * the value schema refuses instead.
 */
const formList = (formData: FormData, name: string): string[] =>
  formData.getAll(name).map((entry) => (typeof entry === "string" ? entry : "\u0000"));

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
    variableKey: formList(formData, "variableKey"),
    variableValue: formList(formData, "variableValue"),
    idempotencyKey: formField(formData, "idempotencyKey"),
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) return { ok: false, error: t("actions.invalidForm") };
    const field = issue.path[0];
    const index = issue.path[1];
    return {
      ok: false,
      error: messageForIssue(t, issue.message),
      ...(isField(field) ? { field } : {}),
      /*
       * Only meaningful alongside a field, and only ever present for the repeated ones —
       * zod builds the row index into the path itself. A rule about the whole list
       * (too many rows, too large together) carries no index, and the form has to toast
       * those rather than look for a row that does not exist.
       */
      ...(isField(field) && typeof index === "number" ? { index } : {}),
    };
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
    const { key, values } = describeActionError(error);
    return { ok: false, error: asTranslate(t)(key as MessageKey, values) };
  }
}

/** Everything `spinUpSchema` produces, which is everything the attempt below needs. */
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
  const { projectId, environmentId, name, image, variableKey, variableValue } = data;

  /*
   * The two parallel lists are one row per index. The schema has already refused a
   * submission where they disagree in length, so this cannot produce a half-row.
   */
  const submittedVariables = variableKey.map((variableName, index) => ({
    name: variableName,
    value: variableValue[index]!,
  }));

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

  const presetNames = new Set((preset?.variables ?? []).map((v) => v.name));
  const sentNames = variables ? Object.keys(variables) : [];
  const presetSent = sentNames.filter((sent) => presetNames.has(sent));

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
    variable_names: presetSent.join(","),
    user_variable_count: sentNames.length - presetSent.length,
  });

  revalidatePath("/dashboard");

  /*
   * Both failures name the container. The service exists and is destroyable; saying only
   * "failed" would leave the user hunting for something they were not told had been
   * created — and on the deploy branch it is a billable orphan they would have no name
   * to search Railway for. The two sentences differ because the remedies differ: refused
   * variables are a preset problem, a refused deploy is Railway's.
   *
   * Retained, both of them, and that is the point of saying so per-branch rather than
   * once at the end: a service exists, so a repeat of this submission must be told about
   * that one rather than make a second.
   */
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

  return {
    value: {
      ok: true,
      /*
       * Gated on what was minted, not on whether any variable was set. A user who typed
       * their own password has their own copy, and pointing them at Railway to read it
       * back would be telling them to go and look up something they already know.
       */
      message: generated
        ? t("actions.spinningUpWithCredentials", { name })
        : t("actions.spinningUp", { name }),
    },
    retain: true,
  };
}

export async function createProject(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("createProject", { trustInboundId: true }, () =>
    addProject(formData),
  );
}

async function addProject(formData: FormData): Promise<ActionResult> {
  const t = await getTranslations();

  const parsed = projectCreateSchema.safeParse({
    name: formField(formData, "projectName"),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) return { ok: false, error: t("actions.invalidForm") };
    return {
      ok: false,
      error: messageForIssue(t, issue.message),
      field: "projectName",
    };
  }

  const { name } = parsed.data;

  try {
    const accessToken = await requireAccessToken();
    const project = await createProjectOnRailway(accessToken, name);

    /*
     * The audit trail, for the same reason `container.created` has one: this creates
     * billable infrastructure under someone's account. The name is user-supplied and
     * bounded at LIMITS.PROJECT_NAME_MAX, and it is the only field that makes the record
     * findable in Railway's own dashboard afterwards.
     *
     * There is no `project.destroyed` counterpart and there never will be — this app does
     * not delete projects, which is why they carry no MANAGED_PREFIX either.
     */
    log.info("project.created", {
      project_id: project.id,
      project_name: name,
      environment_count: project.environments.length,
    });

    revalidatePath("/dashboard");

    /*
     * Railway creates a default environment with the project, and the create mutation
     * returns it — so the ordinary path selects both. The fallback is a project with no
     * environment at all, which the picker already has a sentence for ("This project has
     * no environments"); naming an environment id that does not exist would be worse than
     * saying nothing.
     */
    const environment = project.environments[0];
    return {
      ok: true,
      message: t("actions.projectCreated", { name: project.name }),
      select: {
        projectId: project.id,
        ...(environment ? { environmentId: environment.id } : {}),
      },
    };
  } catch (error) {
    const { key, values } = describeActionError(error);
    return { ok: false, error: asTranslate(t)(key as MessageKey, values) };
  }
}

export async function createEnvironment(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("createEnvironment", { trustInboundId: true }, () =>
    addEnvironment(formData),
  );
}

async function addEnvironment(formData: FormData): Promise<ActionResult> {
  const t = await getTranslations();

  const parsed = environmentCreateSchema.safeParse({
    projectId: formField(formData, "projectId"),
    name: formField(formData, "environmentName"),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) return { ok: false, error: t("actions.invalidForm") };
    /*
     * Attributed to the only field on screen. A bad `projectId` is not something the form
     * can show — it is a hidden input the picker filled in — so its message reaches the
     * user as a toast instead, which is what an absent `field` means.
     */
    const field = issue.path[0];
    return {
      ok: false,
      error: messageForIssue(t, issue.message),
      ...(field === "name" ? { field: "environmentName" as const } : {}),
    };
  }

  const { projectId, name } = parsed.data;

  try {
    const accessToken = await requireAccessToken();
    const environment = await createEnvironmentOnRailway(accessToken, projectId, name);

    log.info("environment.created", {
      project_id: projectId,
      environment_id: environment.id,
      environment_name: name,
    });

    revalidatePath("/dashboard");

    return {
      ok: true,
      message: t("actions.environmentCreated", { name: environment.name }),
      select: { projectId, environmentId: environment.id },
    };
  } catch (error) {
    const { key, values } = describeActionError(error);
    return { ok: false, error: asTranslate(t)(key as MessageKey, values) };
  }
}

/**
 * The event names one lifecycle verb writes, spelled out rather than built.
 *
 * `subsystem.thing.outcome`, from a closed set, and as literals so that grepping the log
 * store for `container.stop_refused` finds the line that emits it — which a template over
 * the verb would not. See .ai/rules/errors-and-logging.md on why the cardinality here is
 * the point.
 */
const LIFECYCLE_EVENTS = {
  destroy: {
    skipped: "container.destroy_skipped",
    refused: "container.destroy_refused",
    done: "container.destroyed",
  },
  stop: {
    skipped: "container.stop_skipped",
    refused: "container.stop_refused",
    done: "container.stopped",
  },
  restart: {
    skipped: "container.restart_skipped",
    refused: "container.restart_refused",
    done: "container.restarted",
  },
  redeploy: {
    skipped: "container.redeploy_skipped",
    refused: "container.redeploy_refused",
    done: "container.redeployed",
  },
} as const;

type LifecycleVerb = keyof typeof LIFECYCLE_EVENTS;

/**
 * The ownership boundary, for every action that changes a container that already exists.
 *
 * One helper rather than four copies, and the reason is the reason the rule exists at all:
 * a second implementation of "re-derive ownership from Railway's own response" is a second
 * chance to get it subtly wrong, and nothing in the types would notice. Everything a
 * lifecycle verb does differently happens inside `run`, after this has already decided the
 * caller may act on this service. `mutation-callsites.test.ts` asserts there is exactly one
 * `!target.managed` in this file and that every infrastructure-changing call sits below it.
 *
 * The deployment id is deliberately not a form field. It comes off `target`, which is
 * Railway's answer to this request — the client posts a service id and nothing else is
 * trusted, exactly as ownership is not.
 */
async function withManagedContainer(
  verb: LifecycleVerb,
  formData: FormData,
  run: (context: {
    accessToken: string;
    projectId: string;
    environmentId: string;
    target: Container;
  }) => Promise<ActionResult>,
): Promise<ActionResult> {
  const t = await getTranslations();
  const events = LIFECYCLE_EVENTS[verb];

  const parsed = containerActionSchema.safeParse({
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
     * is trusted: if the service was not created by this app, the mutation is refused
     * here even though the user's own token would happily perform it.
     *
     * Uncancellable for the same reason as the read in `create` above — see
     * `containerList` in ./data.ts. It is also the read this app would least want to give
     * a deadline to: a signal that fired here would have to refuse the action, never
     * fall through to one, so it buys a new failure mode for a check that must not fail
     * open.
     */
    const { containers } = await getProjectContainers(
      accessToken,
      projectId,
      environmentId,
    );
    const target = containers.find((c) => c.serviceId === serviceId);

    if (!target) {
      log.info(events.skipped, {
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
       * happen through the UI — these controls are only rendered for managed services.
       * Silent, this was indistinguishable from a UI bug; named, it is the difference
       * between a stale page and someone posting service ids by hand.
       */
      log.warn(events.refused, {
        reason: "unmanaged",
        project_id: projectId,
        service_id: serviceId,
      });
      return { ok: false, error: t("actions.notManaged") };
    }

    return await run({ accessToken, projectId, environmentId, target });
  } catch (error) {
    const { key, values } = describeActionError(error);
    return { ok: false, error: asTranslate(t)(key as MessageKey, values) };
  }
}

/**
 * The audit line every lifecycle verb writes when it has changed something.
 *
 * The same field set `container.created` uses, because these change billable
 * infrastructure too and the question asked of the log afterwards is the same one: who did
 * what, to which service, where.
 */
function logLifecycle(
  verb: LifecycleVerb,
  context: {
    projectId: string;
    environmentId: string;
    target: Container;
  },
  extra: { deployment_id?: string | null } = {},
): void {
  log.info(LIFECYCLE_EVENTS[verb].done, {
    project_id: context.projectId,
    environment_id: context.environmentId,
    service_id: context.target.serviceId,
    service_name: context.target.rawName,
    ...extra,
  });
}

export async function spinDown(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("spinDown", { trustInboundId: true }, () =>
    withManagedContainer("destroy", formData, async (context) => {
      /*
       * Resolved here rather than handed down from the helper, for the reason `attempt`
       * gives one screen up: next-intl caches per request so the second call is free, and
       * passing it would mean naming the type `getTranslations()` actually returns — which
       * is wider than the `Translator` alias, since that one is the namespaced overload.
       */
      const t = await getTranslations();

      await destroyContainer(context.accessToken, context.target.serviceId);

      // The other half of the audit trail. After this, Railway has no record it existed.
      logLifecycle("destroy", context);

      revalidatePath("/dashboard");
      return {
        ok: true,
        message: t("actions.destroyed", { name: context.target.displayName }),
      };
    }),
  );
}

export async function stopContainer(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("stopContainer", { trustInboundId: true }, () =>
    withManagedContainer("stop", formData, async (context) => {
      const t = await getTranslations();
      const { deploymentId } = context.target;
      /*
       * Nothing to stop is a state the UI does not offer — the control is gated on the row
       * having a deployment — so this is the stale-page case, and it says so rather than
       * sending Railway an id it does not have.
       */
      if (!deploymentId) {
        return { ok: false, error: t("actions.nothingRunning") };
      }

      await stopDeployment(context.accessToken, deploymentId);

      logLifecycle("stop", context, { deployment_id: deploymentId });

      revalidatePath("/dashboard");
      return {
        ok: true,
        message: t("actions.stopped", { name: context.target.displayName }),
      };
    }),
  );
}

export async function restartContainer(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("restartContainer", { trustInboundId: true }, () =>
    withManagedContainer("restart", formData, async (context) => {
      const t = await getTranslations();
      const { deploymentId } = context.target;
      if (!deploymentId) {
        return { ok: false, error: t("actions.nothingRunning") };
      }

      await restartDeployment(context.accessToken, deploymentId);

      /*
       * The deployment id is recorded although it does not change — that is the point of
       * restart rather than redeploy, and a record that names it is what lets an operator
       * line this up with the log stream the user was watching at the time.
       */
      logLifecycle("restart", context, { deployment_id: deploymentId });

      revalidatePath("/dashboard");
      return {
        ok: true,
        message: t("actions.restarted", { name: context.target.displayName }),
      };
    }),
  );
}

export async function redeployContainer(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("redeployContainer", { trustInboundId: true }, () =>
    withManagedContainer("redeploy", formData, async (context) => {
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
    }),
  );
}
