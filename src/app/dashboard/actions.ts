"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAccessToken } from "@/lib/auth/server";
import { describeActionError, isField, type ActionResult } from "@/lib/action-result";
import {
  createContainer,
  destroyContainer,
  getProjectContainers,
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
  environmentCreateSchema,
  projectCreateSchema,
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

  const { projectId, environmentId, name, image, variableKey, variableValue } =
    parsed.data;

  /*
   * The two parallel lists are one row per index. The schema has already refused a
   * submission where they disagree in length, so this cannot produce a half-row.
   */
  const submittedVariables = variableKey.map((variableName, index) => ({
    name: variableName,
    value: variableValue[index]!,
  }));

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
     * The outer catch also covers the token read and the duplicate-name lookup, where no
     * create was ever attempted and an event named `container.create_failed` would be a
     * lie. Here, a throw means `serviceCreate` itself was refused: nothing exists on
     * Railway, and the record is of an attempt. Every outcome that does leave a service
     * behind returns instead, and is logged as `container.created` below.
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
     */
    if (created.outcome === "variables_failed") {
      return { ok: false, error: t("actions.createdButNotConfigured", { name }) };
    }
    if (created.outcome === "deploy_failed") {
      return { ok: false, error: t("actions.createdButNotDeployed", { name }) };
    }

    return {
      ok: true,
      /*
       * Gated on what was minted, not on whether any variable was set. A user who typed
       * their own password has their own copy, and pointing them at Railway to read it
       * back would be telling them to go and look up something they already know.
       */
      message: generated
        ? t("actions.spinningUpWithCredentials", { name })
        : t("actions.spinningUp", { name }),
    };
  } catch (error) {
    const { key, values } = describeActionError(error);
    return { ok: false, error: asTranslate(t)(key as MessageKey, values) };
  }
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
