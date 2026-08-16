/**
 * Creating a container.
 *
 * One saga over several Railway mutations — the service, its instance settings, its
 * variables, its volume — and the reason it is the longest module in this directory. There
 * is no transaction: each step can fail after the ones before it have already taken effect,
 * so what the function does about a half-built service is the substance of it rather than
 * error handling around the edges.
 */

import "server-only";

import { log } from "@/lib/logger";
// The catalog decides which images get a volume and where it mounts; this layer sends it.
import { presetVolumeFor } from "@/lib/presets";
import { gql, gqlPartial } from "./client";
// The last two steps of the saga, and both are their own module because they are also
// reached on their own: a redeploy of a service that already exists, and a domain added
// to one long after it was created.
import { createServiceDomain } from "./domains";
import { deployService } from "./service-lifecycle";
import {
  SERVICE_CREATE_MUTATION,
  SERVICE_INSTANCE_LIMITS_UPDATE_MUTATION,
  SERVICE_INSTANCE_QUERY,
  SERVICE_INSTANCE_UPDATE_MUTATION,
  VARIABLE_COLLECTION_UPSERT_MUTATION,
  VOLUME_CREATE_MUTATION,
} from "./operations";
import type { RestartPolicyType } from "./graphql.generated";

/**
 * The resource controls the spin-up form's Advanced panel carries.
 *
 * Named types rather than inline members because two call sites build them — the action
 * assembles them from a parsed form, and the tests assemble them by hand — and because the
 * emptiness check below has to take one thing rather than two shapes.
 *
 * None of these is settable on `ServiceCreateInput`. Every one is a follow-up mutation
 * against a service that already exists, which is why they can fail after something has been
 * created.
 */
export type ContainerSettings = {
  region?: string;
  replicas?: number;
  restartPolicy?: RestartPolicyType;
  restartRetries?: number;
  startCommand?: string;
};

export type ContainerLimits = {
  cpu?: number;
  memory?: number;
};

/** Whether a person asked for anything at all, which decides whether a request is made. */
const asked = (values: object): boolean =>
  Object.values(values).some((value) => value !== undefined);

/**
 * What Railway holds for a service instance, as distinct from what it was told.
 *
 * The same five members `ContainerSettings` carries, so the audit line can put the two
 * side by side. Every one is nullable here and optional there, and the difference matters:
 * `undefined` in a request means "do not set this", `null` in a response means "Railway is
 * storing nothing", and the pair `{ asked: "ams", stored: null }` is the whole finding.
 */
export type StoredSettings = {
  region: string | null;
  replicas: number | null;
  restartPolicy: string | null;
  restartRetries: number | null;
  startCommand: string | null;
};

/**
 * Read back what Railway stored, or null if it would not say.
 *
 * **Why this request exists.** Every member of the Advanced panel is write-only: the app
 * sends it and never renders it again, so Railway silently dropping one can only be found
 * by opening Railway's own dashboard and comparing by eye. Two live measurements say that
 * is not hypothetical — a region sent as an airport code was answered `true` and stored as
 * `null`, and a retry count of 3 came back as 10 on one occasion out of many.
 *
 * **Why it cannot fail the create.** By the time this runs the service exists, is deployed,
 * and is on screen. `gqlPartial` and the DEGRADING_OPERATIONS entry are what stop a refused
 * diagnostic from being reported to the user as a failed spin-up. It logs nothing itself:
 * the caller has one audit line for this whole saga and this belongs in it.
 */
async function readStoredSettings(
  accessToken: string,
  params: { serviceId: string; environmentId: string },
  signal?: AbortSignal,
): Promise<StoredSettings | null> {
  const { data } = await gqlPartial(
    SERVICE_INSTANCE_QUERY,
    { serviceId: params.serviceId, environmentId: params.environmentId },
    { accessToken, signal },
  );

  const instance = data?.serviceInstance;
  if (!instance) return null;

  return {
    region: instance.region ?? null,
    replicas: instance.numReplicas ?? null,
    /*
     * `restartPolicyType` and `restartPolicyMaxRetries` are non-null on the schema, which is
     * why they read differently from the three beside them: Railway always holds a value,
     * so what this catches is a value that is not the one asked for rather than an absent
     * one — which is exactly the shape of the retries observation.
     */
    restartPolicy: instance.restartPolicyType,
    restartRetries: instance.restartPolicyMaxRetries,
    startCommand: instance.startCommand ?? null,
  };
}

export async function createContainer(
  accessToken: string,
  params: {
    projectId: string;
    environmentId: string;
    /** Already prefixed by the caller via toManagedName(). */
    name: string;
    image: string;
    /**
     * Merged by the caller from the catalog's defaults and the rows the user submitted,
     * already validated. This layer sets what it is handed.
     *
     * Sent as a separate `variableCollectionUpsert` after the service exists, although
     * `ServiceCreateInput` has a `variables` member that would carry them in the create
     * itself. That is a deliberate choice and the reason was never written down, which is
     * the sort of gap that gets "simplified" later:
     *
     * The create is not the only writer. The edit path has to upsert variables against a
     * service that already exists, so that call has to work standalone regardless — and
     * having one code path set a service's environment rather than two is worth an extra
     * round trip on a form submission a person is watching. It also keeps the failure
     * separable: a service that was created and then failed to take its variables is a
     * state this app can report and the user can fix, where a create that failed as a whole
     * leaves nothing to point at.
     */
    variables?: Record<string, string>;
    /**
     * The port a public domain should route to, or absent to mint no domain at all.
     *
     * Absent is what every database preset sends and what a person who cleared the form's
     * port field sends, and the two are the same request: do not put this container on the
     * public internet. See `port` in lib/validation.ts on why one field carries both.
     */
    targetPort?: number;
    /**
     * What the service should be, beyond the image it runs.
     *
     * Two objects rather than one, and the split is Railway's rather than this app's:
     * `serviceInstanceUpdate` takes the first and `serviceInstanceLimitsUpdate` takes the
     * second, and the second is gated by the plan behind the token where the first is not.
     * Collapsing them here would mean one refusal for two different problems with two
     * different remedies — see the outcome union below.
     *
     * Every member is optional and an absent one is not sent at all. That is what keeps a
     * spin-up nobody customised at the three round trips it has always taken: an object with
     * nothing in it issues no mutation, which `api.integration.test.ts` asserts rather than
     * this comment promising.
     */
    settings?: ContainerSettings;
    limits?: ContainerLimits;
  },
  signal?: AbortSignal,
): Promise<{
  serviceId: string;
  deploymentId: string | null;
  /**
   * Where the container will answer, or null because it was not asked for or because
   * Railway refused to mint it.
   *
   * Deliberately NOT a member of `outcome` below, and that asymmetry is the point. Every
   * value of `outcome` means the user has an un-deployed service to go and clean up; a
   * container that is running without an address needs no cleanup and is not broken. It is
   * a working container missing one convenience, and the row's own domain control is the
   * remedy — so a refusal here degrades the sentence the user is shown rather than turning
   * a successful spin-up into a failed one.
   */
  url: string | null;
  /**
   * What Railway actually holds for the settings it was sent, read back once.
   *
   * Null on every failure branch and on a spin-up that customised nothing: there is no
   * settled service to read on the first, and nothing worth comparing on the second. Null
   * also when Railway refused the read — see `readStoredSettings`, which degrades rather
   * than throwing, because a container that exists must not be reported as a failure over
   * a diagnostic.
   *
   * Consumed by the caller's audit line and nothing else. It reaches no screen, which is
   * deliberate: rendering it would be a settings readout, and that is a feature with its
   * own ticket rather than something to grow out of a log field.
   */
  stored: StoredSettings | null;
  /**
   * What happened after `serviceCreate` returned.
   *
   * All five failure values mean the same thing to the caller — the service exists and is
   * not running — but they are different sentences to a user and different lines in the
   * audit log, so they are not collapsed into a boolean. Reaching any of the six means a
   * service was created; only a throw from this function means none was.
   */
  outcome:
    | "deployed"
    | "settings_failed"
    | "limits_failed"
    | "volume_failed"
    | "variables_failed"
    | "deploy_failed";
}> {
  const created = await gql(
    SERVICE_CREATE_MUTATION,
    {
      input: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        name: params.name,
        source: { image: params.image },
      },
    },
    { accessToken, signal },
  );

  const serviceId = created.serviceCreate.id;

  /*
   * The settings FIRST, ahead of the volume as well as the deploy.
   *
   * `region` is the member that fixes the order. A volume is provisioned for the service as
   * it stands when `volumeCreate` runs, so a region applied afterwards is a region applied to
   * a service whose storage was already placed — and this app has no way to move it. Setting
   * it before anything else exists is the one ordering with nothing to reconcile.
   *
   * The rest of the members have no such constraint and are sent here anyway, because a
   * container's replica count and start command belong to the service before its first
   * deployment rather than to a redeploy afterwards. There is only one deployment on this
   * path, and it should be the one the user described.
   *
   * A refusal does not deploy, on the argument the volume and variables branches below both
   * make: an un-deployed service is visible, prefixed and destroyable, where a container
   * running in a region nobody asked for — or with one replica where five were requested —
   * is a container quietly not doing what the form said it would.
   */
  if (params.settings && asked(params.settings)) {
    const settings = params.settings;
    try {
      await gql(
        SERVICE_INSTANCE_UPDATE_MUTATION,
        {
          serviceId,
          /*
           * Always sent, for the reason SERVICE_INSTANCE_UPDATE_MUTATION's own comment
           * gives: an omitted environment updates the service in every environment that is
           * not a fork, which is a blast radius nobody asked for from a form naming one.
           */
          environmentId: params.environmentId,
          input: {
            ...(settings.region === undefined ? {} : { region: settings.region }),
            ...(settings.replicas === undefined
              ? {}
              : { numReplicas: settings.replicas }),
            ...(settings.restartPolicy === undefined
              ? {}
              : { restartPolicyType: settings.restartPolicy }),
            ...(settings.restartRetries === undefined
              ? {}
              : { restartPolicyMaxRetries: settings.restartRetries }),
            ...(settings.startCommand === undefined
              ? {}
              : { startCommand: settings.startCommand }),
          },
        },
        { accessToken, signal },
      );
    } catch (error) {
      /*
       * The length of the start command, never the command.
       *
       * Everything else here is closed or tightly bounded — a region out of Railway's own
       * list, a count under LIMITS.REPLICAS_MAX, one of three policy names — so naming them
       * keeps the record diagnostic without making it attacker-chosen. The command is the
       * one free-text field on the panel, which is the same split `container.created` makes
       * between preset variable names and a count of the user's.
       */
      log.warn("railway.settings_failed", {
        service_id: serviceId,
        region: settings.region ?? "",
        replicas: settings.replicas ?? 0,
        restart_policy: settings.restartPolicy ?? "",
        restart_retries: settings.restartRetries ?? -1,
        start_command_length: settings.startCommand?.length ?? 0,
        error,
      });
      return {
        serviceId,
        deploymentId: null,
        url: null,
        stored: null,
        outcome: "settings_failed",
      };
    }
  }

  /*
   * Sizing, as its own step and its own outcome.
   *
   * Railway gates this one by plan and does not gate the one above, so the two refusals mean
   * different things and have different remedies — "ask for less, or leave both blank" against
   * "the settings themselves were rejected". A single try around both would have to pick one
   * sentence for both cases, and the one it picked would be wrong half the time.
   */
  if (params.limits && asked(params.limits)) {
    const limits = params.limits;
    try {
      await gql(
        SERVICE_INSTANCE_LIMITS_UPDATE_MUTATION,
        {
          input: {
            environmentId: params.environmentId,
            serviceId,
            ...(limits.cpu === undefined ? {} : { vCPUs: limits.cpu }),
            ...(limits.memory === undefined ? {} : { memoryGB: limits.memory }),
          },
        },
        { accessToken, signal },
      );
    } catch (error) {
      log.warn("railway.limits_failed", {
        service_id: serviceId,
        vcpus: limits.cpu ?? 0,
        memory_gb: limits.memory ?? 0,
        error,
      });
      return {
        serviceId,
        deploymentId: null,
        url: null,
        stored: null,
        outcome: "limits_failed",
      };
    }
  }

  /*
   * The volume BEFORE the deploy, and before the variables, for a reason the variables note
   * below only half covers.
   *
   * A first deploy without the mount runs the image's own initialisation against the
   * container filesystem — `initdb`, `mongod --repair`, RabbitMQ writing a fresh Mnesia
   * schema. Attaching the volume afterwards mounts an empty filesystem *over the top* of
   * that work, so the second deployment comes up as an empty database with a password the
   * user was already told about. It looks exactly like the data loss this ticket exists to
   * fix, and it would happen on the very first container.
   *
   * Only for an image the catalog knows keeps state. A bare image gets no volume: this app
   * cannot guess where an arbitrary container writes, and a volume mounted at the wrong path
   * is billable storage that stays empty while the data still vanishes.
   */
  const volume = presetVolumeFor(params.image);
  if (volume) {
    try {
      const attached = await gql(
        VOLUME_CREATE_MUTATION,
        {
          input: {
            projectId: params.projectId,
            /*
             * Always sent, never omitted. Per the schema's own description, `undefined`
             * deploys the volume to EVERY environment in the project — so leaving it out
             * for a service that lives in one would quietly provision billable storage in
             * all the others.
             */
            environmentId: params.environmentId,
            serviceId,
            mountPath: volume.mountPath,
          },
        },
        { accessToken, signal },
      );

      /*
       * Recorded because it is the ownership marker, and this app did not write it.
       * Railway derives the volume's name from the service's — `spun-pg` gets
       * `spun-pg-volume` — so the MANAGED_PREFIX reaches the volume without a rename. See
       * ADR-14, and OPTIONAL_FIELDS on `volumeUpdate` for what happens if that changes.
       */
      log.info("railway.volume_created", {
        service_id: serviceId,
        volume_id: attached.volumeCreate.id,
        volume_name: attached.volumeCreate.name,
        mount_path: volume.mountPath,
      });
    } catch (error) {
      /*
       * Does not deploy, on the same argument as the variables branch below: a stateful
       * container that comes up healthy and silently discards every write is worse than an
       * un-deployed service the dashboard shows and the user can destroy. This is the whole
       * defect T-491 was raised for, and deploying here would reintroduce it on the one path
       * that knows it is happening.
       */
      log.warn("railway.volume_failed", {
        service_id: serviceId,
        mount_path: volume.mountPath,
        error,
      });
      return {
        serviceId,
        deploymentId: null,
        url: null,
        stored: null,
        outcome: "volume_failed",
      };
    }
  }

  /*
   * Variables BEFORE the deploy, never after.
   *
   * A postgres container started without POSTGRES_PASSWORD exits on its first tick and
   * Railway restarts it forever — the user watches a crash loop and reasonably concludes
   * this app is broken. Setting them afterwards would need a redeploy and would show that
   * crash loop first.
   *
   * A failure here deliberately does NOT deploy, for the same reason the comment below
   * gives: an un-deployed service is visible, prefixed and destroyable from the
   * dashboard, which is strictly better than a running container in a restart loop
   * nobody can diagnose.
   */
  if (params.variables && Object.keys(params.variables).length > 0) {
    try {
      await gql(
        VARIABLE_COLLECTION_UPSERT_MUTATION,
        {
          input: {
            projectId: params.projectId,
            environmentId: params.environmentId,
            serviceId,
            variables: params.variables,
            replace: false,
            /*
             * Railway redeploys a service when its variables change. The explicit deploy
             * below is the one this app tracks — it returns the deployment id the row's
             * log stream keys on — so a second, variable-triggered deployment would leave
             * the user watching logs from a deployment that is not the current one.
             */
            skipDeploys: true,
          },
        },
        { accessToken, signal },
      );
    } catch (error) {
      /*
       * A count, not names, and never values.
       *
       * Since T-487 this map is a merge of catalog defaults and rows the user typed, so
       * the names are no longer a closed set — the same reason the rejected deploymentId
       * is not logged. Nothing is lost: the caller's `container.created` line is written
       * on this path too, with `outcome: "variables_failed"`, and it names the closed
       * half.
       */
      log.warn("railway.variables_failed", {
        service_id: serviceId,
        variable_count: Object.keys(params.variables).length,
        error,
      });
      return {
        serviceId,
        deploymentId: null,
        url: null,
        stored: null,
        outcome: "variables_failed",
      };
    }
  }

  /*
   * serviceCreate registers the service; the deploy is a separate step. If this second
   * call fails the service exists but is not running, which the dashboard shows as an
   * un-deployed container the user can destroy — better than silently orphaning it.
   *
   * Caught for the same reason the variables call above is: a throw from here would carry
   * no service id, so the caller could not tell "nothing was created" from "a billable
   * service was created and left un-deployed", and would log neither. The classification
   * this discards from the user's sentence — auth, rate limit, outage — is entirely
   * preserved in the record below, incident id included.
   */
  let deploymentId: string | null;
  try {
    deploymentId = await deployService(
      accessToken,
      { serviceId, environmentId: params.environmentId },
      signal,
    );
  } catch (error) {
    log.warn("railway.deploy_failed", { service_id: serviceId, error });
    return {
      serviceId,
      deploymentId: null,
      url: null,
      stored: null,
      outcome: "deploy_failed",
    };
  }

  /*
   * The domain LAST, and after the deploy rather than before it.
   *
   * Every other call in this function runs before the deploy, and each has a reason the
   * container would be wrong without it — an empty volume mounted over an initialised
   * database, a postgres with no password crash-looping. A domain has no such reason: it
   * routes to a container that is already coming up, and Railway's edge starts answering
   * when the service does whether the domain was minted a second earlier or a second later.
   *
   * Placed before the deploy, a refusal here would have to choose between deploying anyway
   * — leaving a failed call in the middle of the sequence — and not deploying, which would
   * cost the user a running container in exchange for a hostname. Placed here, the worst
   * case is the container they asked for, running, with no address; and unlike every branch
   * above, that state has a remedy inside the app.
   *
   * Only when a port was asked for. `serviceDomainCreate` accepts a null `targetPort` and
   * infers one from the deployment, and this path deliberately does not use that: the
   * catalog knows the port for every image it offers and the form carries it for every image
   * it does not, so an absent port here means the user asked for no domain rather than that
   * the port is unknown.
   */
  let url: string | null = null;
  if (params.targetPort !== undefined) {
    try {
      url = await createServiceDomain(
        accessToken,
        {
          environmentId: params.environmentId,
          serviceId,
          targetPort: params.targetPort,
        },
        signal,
      );
    } catch (error) {
      /*
       * Warn and carry on, which no other branch in this function does.
       *
       * The port is in the record because it is the field most likely to be the cause: an
       * image that serves nothing on the port the catalog claims, or a number a person
       * typed for a custom image. It is a bounded integer from `spinUpSchema` rather than
       * free text, so it is safe to log — unlike the variable names two branches up.
       */
      log.warn("railway.domain_failed", {
        service_id: serviceId,
        target_port: params.targetPort,
        error,
      });
    }
  }

  /*
   * Only when something was asked for, which is the same test the settings mutation itself
   * is gated on.
   *
   * Two reasons, and the second is a promise this module has already made. There is nothing
   * to compare when nobody customised anything — a read-back of five defaults says only
   * that Railway has defaults. And the round-trip count for an uncustomised spin-up is a
   * property this file states outright and `api.integration.test.ts` asserts: an
   * unconditional query here would quietly add a fourth request to the path most people
   * take, to diagnose settings they never sent.
   */
  const stored =
    params.settings && asked(params.settings)
      ? await readStoredSettings(
          accessToken,
          { serviceId, environmentId: params.environmentId },
          signal,
        )
      : null;

  return { serviceId, deploymentId, url, stored, outcome: "deployed" };
}
