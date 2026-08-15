"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAccessToken, requireSession } from "@/lib/auth/server";
import type { z } from "zod";
import {
  describeActionError,
  isField,
  type ActionField,
  type ActionResult,
} from "@/lib/action-result";
import { runOnce, type Retainable } from "@/lib/idempotency";
import {
  createContainer,
  createServiceDomain,
  deleteVolume,
  deployService,
  destroyContainer,
  getEnvironmentVolumes,
  getProjectContainers,
  readServiceVariableNames,
  restartDeployment,
  stopDeployment,
  updateContainer,
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
import { stripPrefix, toManagedName } from "@/lib/railway/managed";
import { httpPortFor, presetFor } from "@/lib/presets";
import { resolveVariables } from "@/lib/railway/secrets";
import { SessionExpiredError } from "@/lib/auth/refresh";
import {
  VALIDATION_KEYS,
  VALIDATION_VALUES,
  containerActionSchema,
  containerBulkActionSchema,
  containerEditSchema,
  environmentCreateSchema,
  pairVariableRows,
  projectCreateSchema,
  spinUpSchema,
} from "@/lib/validation";
import type { Translate } from "@/lib/messages";
import type { Container, ContainerVolume } from "@/lib/railway/types";

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
 * Not `MessageKey`: that union is the `errors.*` subset reachable from code with no
 * translator, and these two are ordinary catalog keys resolved right here. Spelled as a
 * literal union rather than `string` so a typo is a compile error, and so the set stays
 * small enough to read — a third fallback is a question worth asking, not a default.
 */
type IssueFallbackKey = "actions.invalidForm" | "actions.missingReference";

type IssueShape = {
  /** Schema field name → the `ActionField` the form actually renders. */
  rename?: Readonly<Record<string, ActionField>>;
  /** The message when zod produced no issue at all. */
  fallback?: IssueFallbackKey;
  /** Off for schemas whose every field is a hidden input. */
  attribute?: false;
};

/**
 * A failed parse, as the result the caller returns.
 *
 * Written five times before this, and three of the copies had already drifted: spin-up and
 * edit carried the full field-and-index attribution, `addProject` hardcoded a field name
 * rather than reading the path, `addEnvironment` remapped one, and `destroyMany` dropped
 * attribution altogether and used a different fallback. Four behaviours from one rule, none
 * of them wrong exactly, and no way to tell deliberate from forgotten by reading them.
 *
 * The differences are the three options above, so they are stated rather than reimplemented:
 *
 * `rename` exists because two schemas call their field `name` while the form renders it as
 * `projectName` or `environmentName`. Without it the attribution lands on an input that is
 * not on the page, which reads to the user as no error at all.
 *
 * `fallback` is for an error with no issues in it — a shape no browser produces.
 * `destroyMany` wants a different sentence for that than the forms do.
 *
 * `attribute: false` is `destroyMany` again: every field it validates is a hidden input the
 * page filled in, so there is nothing on screen to point at and the message has to be a toast.
 */
function issueToResult(
  t: Translator,
  error: z.ZodError,
  { rename, fallback = "actions.invalidForm", attribute }: IssueShape = {},
): ActionResult {
  const issue = error.issues[0];
  // The same cast every call through `Translator` makes; see messageForIssue.
  if (!issue) return { ok: false, error: t(fallback as Parameters<Translator>[0]) };

  const result: ActionResult = {
    ok: false,
    error: messageForIssue(t, issue.message),
  };
  if (attribute === false) return result;

  const [path, index] = issue.path;
  const field =
    typeof path === "string" && rename?.[path]
      ? rename[path]
      : isField(path)
        ? path
        : null;
  if (!field) return result;

  return {
    ...result,
    field,
    /*
     * Only meaningful alongside a field, and only ever present for the repeated ones — zod
     * builds the row index into the path itself. A rule about the whole list (too many rows,
     * too large together) carries no index, and the form has to toast those rather than look
     * for a row that does not exist.
     */
    ...(typeof index === "number" ? { index } : {}),
  };
}

/**
 * Any thrown value, as the result the caller returns.
 *
 * The five catch blocks that used to hold these two lines were byte-identical, and
 * `data.ts` has a sixth against `reportError`. Both casts go with them: `describeActionError`
 * already returns a `MessageDescriptor` whose key is a `MessageKey`, so `key as MessageKey`
 * was re-asserting a type the value already had, and `asTranslate` exists precisely to make
 * the second one unnecessary.
 */
function toActionError(t: Translator, error: unknown): ActionResult {
  const { key, values } = describeActionError(error);
  return { ok: false, error: asTranslate(t)(key, values) };
}

/**
 * The two audit fields describing a service's environment, split by who chose the names.
 *
 * SECURITY.md's bounded-cardinality rule, expressed once. Preset-derived names come from
 * this app's own catalog, so they are a closed set and safe to name; everything else a
 * person typed is unbounded and attacker-chosen in exactly the way the rejected
 * `deploymentId` is, so it is counted instead. The record says how many variables a user
 * set, not which — an accepted loss, argued in SECURITY.md.
 *
 * `container.created` and `container.updated` each computed this inline, identically. Two
 * copies of a redaction rule is one copy that can quietly start logging the names.
 */
function variableAudit(
  image: string,
  variables: Record<string, string> | undefined,
): { variable_names: string; user_variable_count: number } {
  const presetNames = new Set(
    (presetFor(image)?.variables ?? []).map((variable) => variable.name),
  );
  const sentNames = variables ? Object.keys(variables) : [];
  const presetSent = sentNames.filter((sent) => presetNames.has(sent));
  return {
    variable_names: presetSent.join(","),
    user_variable_count: sentNames.length - presetSent.length,
  };
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
    // The schema has one field, `name`, and the form renders it as `projectName`.
    return issueToResult(t, parsed.error, { rename: { name: "projectName" } });
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
    return toActionError(t, error);
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
    /*
     * Attributed to the only field on screen. A bad `projectId` is not something the form
     * can show — it is a hidden input the picker filled in — so its message reaches the
     * user as a toast instead, which is what an absent `field` means. `projectId` is not an
     * ActionField, so it falls through to exactly that.
     */
    return issueToResult(t, parsed.error, { rename: { name: "environmentName" } });
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
    return toActionError(t, error);
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
    /*
     * Destroy alone carries a fourth outcome, because destroy alone is asked about several
     * containers at once. Everywhere else a refused mutation ends the request and reaches
     * the log through `reportError` under an `action` line; inside a batch it ends one
     * entry, the request goes on, and this is the only record that names which entry.
     */
    failed: "container.destroy_failed",
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
  edit: {
    skipped: "container.edit_skipped",
    refused: "container.edit_refused",
    done: "container.updated",
  },
  domain: {
    skipped: "container.domain_skipped",
    refused: "container.domain_refused",
    done: "container.domain_created",
  },
} as const;

type LifecycleVerb = keyof typeof LIFECYCLE_EVENTS;

/** What the ownership boundary decided about one service id the browser posted. */
type ManagedResolution =
  | { managed: true; target: Container }
  | { managed: false; reason: "gone" | "unmanaged" };

/**
 * The ownership boundary itself, for exactly one service.
 *
 * The only `!target.managed` in this file, which `mutation-callsites.test.ts` asserts by
 * counting. It is a function rather than two lines inside `withManagedContainer` because
 * destroy can now be asked about several services at once, and the alternative was a second
 * copy of "find the service, refuse an unmanaged one" written for the batch — the second
 * implementation that rule exists to prevent, and the one that would have been subtly weaker
 * because it was written under a loop.
 *
 * Per service, and that is the property the bulk path depends on: a batch is a list of
 * individual decisions taken against one read, never one decision taken about a list.
 *
 * It logs nothing and reads nothing. The caller owns the log line, because the event name is
 * the verb's, and the caller owns the read, because a batch must not make one per service.
 */
function resolveManagedTarget(
  containers: Container[],
  serviceId: string,
): ManagedResolution {
  const target = containers.find((c) => c.serviceId === serviceId);
  if (!target) return { managed: false, reason: "gone" };
  if (!target.managed) return { managed: false, reason: "unmanaged" };
  return { managed: true, target };
}

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
    /**
     * Everything else in the environment, from the same read that found `target`.
     *
     * Only the edit verb uses it, and only to refuse a rename onto a name that is already
     * taken. Handed down rather than re-read: the list is already in hand, and a second
     * `getProjectContainers` would be a round trip spent re-learning what this one just
     * proved, against the rate limit that shapes every read in this app.
     */
    containers: Container[];
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
    const resolution = resolveManagedTarget(containers, serviceId);

    if (!resolution.managed) {
      if (resolution.reason === "gone") {
        log.info(events.skipped, {
          reason: "gone",
          project_id: projectId,
          service_id: serviceId,
        });
        revalidatePath("/dashboard");
        return { ok: false, error: t("actions.gone") };
      }
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

    return await run({
      accessToken,
      projectId,
      environmentId,
      target: resolution.target,
      containers,
    });
  } catch (error) {
    return toActionError(t, error);
  }
}

/**
 * The audit line every lifecycle verb writes when it has changed something.
 *
 * The same field set `container.created` uses, because these change billable
 * infrastructure too and the question asked of the log afterwards is the same one: who did
 * what, to which service, where.
 *
 * `extra` is scalars, which is not merely a convenience: it is `LogFields`' own rule
 * restated at the one place a verb gets to add to this record, so "edit adds a variable
 * count" is expressible here and "edit adds the variables" is not.
 */
function logLifecycle(
  verb: LifecycleVerb,
  context: {
    projectId: string;
    environmentId: string;
    target: Container;
  },
  extra: Record<string, string | number | boolean | null | undefined> = {},
): void {
  log.info(LIFECYCLE_EVENTS[verb].done, {
    project_id: context.projectId,
    environment_id: context.environmentId,
    service_id: context.target.serviceId,
    service_name: context.target.rawName,
    ...extra,
  });
}

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
       * claiming one was kept would be a statement it cannot support. README Limitations says
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
    }),
  );
}

/**
 * Destroying several containers on one confirmation.
 *
 * Deliberately not `withManagedContainer` in a loop, and the difference is one Railway read
 * against N of them: the helper fetches the container list to resolve its single service, so
 * six of them would be six full project queries plus six volume reads to answer a question
 * one read already answers. This reads once and resolves each id against that answer.
 *
 * What does NOT change with the batch is the guard. `resolveManagedTarget` runs per service,
 * on Railway's own response, exactly as it does for one — a batch is a list of individual
 * decisions, never one decision about a list — and every refusal is logged under its own
 * service id rather than summarised.
 *
 * The mutations are sequential and a failure does not stop the rest. Sequential because each
 * entry is up to two mutations against a quota Railway documents at 1,000 an hour, and fifty
 * of them at once is the shape that gets rate-limited; continuing because a batch that
 * stopped halfway would leave the user with a partially destroyed environment and a sentence
 * about the one that failed.
 */
export async function spinDownMany(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("spinDownMany", { trustInboundId: true }, () =>
    destroyMany(formData),
  );
}

async function destroyMany(formData: FormData): Promise<ActionResult> {
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
 * Taking `mutate` as a parameter removed the literal `stopDeployment(` and
 * `restartDeployment(` from this file, and `mutation-callsites.test.ts` reads exactly that:
 * it asserts every infrastructure-changing call appears textually below the one
 * `!target.managed` guard. An indirect call satisfies nothing it can see, so the first
 * version of this helper turned a verified structural property into an unverified one while
 * every behavioural test stayed green. The test caught it. Two lines of branch is the price
 * of the guard staying checkable, and it is worth paying on a path that changes somebody
 * else's infrastructure.
 */
function deploymentAction(
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
export async function generateDomain(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return withRequestScope("generateDomain", { trustInboundId: true }, () =>
    withManagedContainer("domain", formData, async (context) => {
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
    }),
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
async function edit(formData: FormData): Promise<ActionResult> {
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
