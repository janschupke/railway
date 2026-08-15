/**
 * In-memory Railway, just enough of it.
 *
 * Deployments advance QUEUED → BUILDING → DEPLOYING → SUCCESS on a timer so the UI's
 * status transitions and log streaming are exercised for real rather than asserted
 * against a frozen fixture.
 */

/**
 * `severity` because the app's log documents all request it and the pane's filter is
 * built from whatever values arrive. Without it here the adaptive control has no browser
 * coverage at all — it correctly renders nothing, which is indistinguishable from broken.
 */
type LogLine = { timestamp: string; message: string; severity: string };

/** One node of the `deploymentEvents` connection, with the members the app selects. */
export type DeploymentEvent = {
  step: string;
  payload: {
    error: string | null;
    reason: string | null;
    detail: string | null;
    skipped: boolean;
  };
};

export type Deployment = {
  id: string;
  serviceId: string;
  status: string;
  updatedAt: string;
  /**
   * The two phases Railway keeps apart, kept apart here too.
   *
   * This was one array served for both `buildLogs` and `deploymentLogs`, which made the
   * fixture structurally incapable of expressing the failure it is now used to test: a
   * service created from an image performs no build, so real build logs are empty, and a
   * pull that fails writes nothing to the deploy logs either. With one array every phase
   * always had output and the app's phase selection could never be wrong.
   */
  logs: { build: LogLine[]; deploy: LogLine[] };
  /**
   * Deployment events, as `deploymentEvents` returns them.
   *
   * A failed deployment's reason lives here and in no other part of Railway's API — the
   * Deployment type carries a status and no explanation at all — so a fixture without
   * these cannot express the case the failed row now exists to render.
   */
  events: DeploymentEvent[];
  /**
   * When the deployment was created, which is what a row measures uptime from.
   *
   * A real timestamp, unlike `updatedAt`'s epoch-zero start. The Project query used to
   * report `service.createdAt` here — `new Date(0)` — so every seeded row would have shown
   * an uptime of fifty-six years the moment a readout existed to show it.
   */
  createdAt: string;
  /** Index into PROGRESSION. */
  step: number;
  failing: boolean;
  /** Which phases this deployment writes to; snapshotted from the fault at creation. */
  logPhase: LogPhaseFault;
};

export type Service = {
  id: string;
  name: string;
  projectId: string;
  environmentId: string;
  image: string | null;
  repo: string | null;
  createdAt: string;
  deploymentId: string | null;
  /**
   * Environment set at creation. Never rendered by the app — a spec asserts the *names*
   * and the length of a generated value through /__test/services, so the fixture cannot
   * leak a credential into the page it is checking.
   */
  variables: Record<string, string>;
  /**
   * The hostnames Railway has minted for this service, newest last.
   *
   * A list rather than one value because that is what the real API answers, and the shape
   * is what the mapper's ordering rule is about: `serviceDomainCreate` mints a second domain
   * rather than refusing one, so a fixture holding a single value could not reproduce the
   * state the app's own guard exists to prevent.
   */
  domains: string[];
  /**
   * The resource controls a spin-up asked for, as Railway would hold them.
   *
   * Never rendered by the app — nothing reads a service's region back — so a spec asserts
   * them through /__test/services, which is the same route the variable names are checked
   * by and for the same reason: it is the only way to prove the values reached Railway
   * rather than merely reached the form.
   */
  settings: {
    region: string | null;
    replicas: number | null;
    restartPolicy: string | null;
    restartRetries: number | null;
    startCommand: string | null;
    vcpus: number | null;
    memoryGB: number | null;
  };
};

/**
 * A volume, flattened.
 *
 * Railway models this as a `Volume` with a `VolumeInstance` per environment, and the app
 * reads only the instance — so the fixture keeps one record carrying both ids rather than
 * two tables it would never join differently. `serviceId` is nullable for the state that
 * matters most here: the orphan a destroy leaves behind when the user keeps the data.
 */
export type Volume = {
  id: string;
  instanceId: string;
  name: string;
  projectId: string;
  environmentId: string;
  serviceId: string | null;
  mountPath: string;
  sizeMB: number;
  currentSizeMB: number;
};

const PROGRESSION = ["QUEUED", "BUILDING", "DEPLOYING", "SUCCESS"] as const;
const FAILING_PROGRESSION = ["QUEUED", "BUILDING", "FAILED"] as const;

/**
 * Which DeploymentEventStep each status transition reports.
 *
 * Railway's steps are finer-grained than its statuses, so this is a plausible mapping
 * rather than a faithful one — the app only reads the step off the *last* event, and what
 * matters for a spec is that the step is a member the catalog knows.
 */
const STATUS_STEPS: Record<string, string> = {
  QUEUED: "SNAPSHOT_CODE",
  BUILDING: "BUILD_IMAGE",
  DEPLOYING: "CREATE_CONTAINER",
  SUCCESS: "HEALTHCHECK",
  FAILED: "BUILD_IMAGE",
};

/** What a failed deployment says. A pull that never resolves is the commonest real shape. */
export const FAILURE_TEXT = 'image "redis:does-not-exist" not found in registry';

/** Fast enough that a spec does not wait, slow enough that transitions are observable. */
export const TICK_MS = 400;

/**
 * Which connection the fixture hangs projects off.
 *
 * The fixture used to answer `me.projects` unconditionally, which is exactly why it
 * never caught a real account whose projects arrive somewhere else: the only shape it
 * knew was the shape that worked. These are the shapes that have to keep working.
 */
export type ProjectsSource =
  | "personal" // me.projects only
  | "workspace" // me.workspaces[].team.projects only
  | "both" // in both connections — the de-duplication case
  | "none"; // authorized, but nothing to show

/**
 * Which phase a new deployment writes its output to.
 *
 * `both` is what Railway does for a repo source and is the default, so every spec written
 * before this knob existed is unaffected. The other three are the shapes an image source
 * actually produces: output in one phase only, or — for a pull that never resolves —
 * nothing anywhere, which is the case that reaches the user as an empty pane.
 */
export type LogPhaseFault = "both" | "build" | "deploy" | "none";

/**
 * Which member of DeploymentEventPayload carries the failure text, if any.
 *
 * A knob rather than a constant precisely *because* the real answer is unverified: which
 * of these Railway populates has never been observed on a real failed deployment, only
 * introspected. The app tries all three, and a spec per shape is the only mechanical
 * evidence available that it copes with each. `none` is the feed that answers with steps
 * and no words at all.
 */
export type FailureFieldFault = "error" | "reason" | "detail" | "none";

export type Faults = {
  /** Next N GraphQL calls answer 429. */
  rateLimit: number;
  /** Next N GraphQL calls answer 401. */
  unauthorized: number;
  /** The refresh grant fails, simulating a revoked authorization. */
  refreshFails: boolean;
  /** Access tokens are issued with this lifetime, to force a refresh mid-session. */
  accessTokenTtl: number;
  /** Newly created deployments fail their build. */
  deploymentsFail: boolean;
  /** Which phase newly created deployments write their output to. */
  logPhase: LogPhaseFault;
  /** Which payload member a failing deployment's last event carries its text on. */
  failureField: FailureFieldFault;
  /**
   * `deploymentEvents` is refused, as it would be for a token without the scope.
   *
   * Read at request time rather than snapshotted onto the deployment, unlike `logPhase`:
   * this describes what the API will answer, not what a deployment did.
   */
  deploymentEventsFail: boolean;
  /** variableCollectionUpsert is refused, stranding a service before its deploy. */
  variablesFail: boolean;
  /**
   * `serviceDomainCreate` is refused.
   *
   * The one Railway refusal in the create path that must NOT stop the container: a spin-up
   * that asked for an address and did not get one still deployed, still succeeded, and still
   * says so. Reused by the row control, where the same refusal is a plain failure because
   * minting the domain is the whole of what that action does.
   */
  domainFails: boolean;
  /**
   * `serviceInstanceUpdate` is refused, stranding a customised service before its deploy.
   *
   * Not deploying is the point, on the volume branch's argument: a container running in a
   * region nobody asked for, or with one replica where three were requested, is a container
   * quietly not doing what the form said it would.
   */
  settingsFail: boolean;
  /**
   * `serviceInstanceLimitsUpdate` is refused, as it is for a plan that does not allow the
   * size asked for.
   *
   * Its own knob rather than a share of `settingsFail`, because the two refusals mean
   * different things to a user: this one is answered by asking for less, and that one is not.
   */
  limitsFail: boolean;
  /**
   * `volumeCreate` is refused, stranding a stateful service before its deploy.
   *
   * The branch this exists for is the one that must NOT deploy: a database whose volume
   * Railway refused would come up looking healthy and lose everything written to it.
   */
  volumeCreateFail: boolean;
  /**
   * `environment.volumeInstances` is refused, as it would be for an unscoped token.
   *
   * Separate from `volumeCreateFail` because they break opposite halves: this one leaves
   * every volume in place and blinds the app to them, so the row shows no volume and the
   * destroy dialog offers no choice — which must keep the data rather than silently drop it.
   */
  volumesFail: boolean;
  /**
   * `metrics` is refused, as it would be for a token the project scope does not cover.
   *
   * Separate from `workspaceFail` for the reason `rejectPersonal` and `rejectWorkspaces`
   * are separate: the two halves of ProjectMetrics fail independently, and refusing the
   * spend figure must leave the per-row readouts on screen.
   */
  metricsFail: boolean;
  /** `project.workspace` is refused, as it is for a token without `workspace:viewer`. */
  workspaceFail: boolean;
  /** The project belongs to no workspace, as a personal Railway project does. */
  noWorkspace: boolean;
  /** Where the Projects query finds projects, if anywhere. */
  projectsSource: ProjectsSource;
  /**
   * Railway refuses one project source, as it does for a token missing that scope.
   *
   * Separate knobs because the point of the split documents is that these are separate
   * failures: refusing workspaces must leave the personal list on screen, and refusing
   * everything must produce a named authorization error rather than an empty page.
   */
  rejectWorkspaces: boolean;
  rejectPersonal: boolean;
  /**
   * The account genuinely holds no projects, as a new Railway account does.
   *
   * Not the same state as `projectsSource: "none"`, and the difference is the whole point
   * of the create flow. That fault makes the *sources* answer with nothing while the store
   * still holds projects — an account whose projects are somewhere this app does not look.
   * This one empties the store, so a project created during a spec becomes visible in the
   * very next read, which is what a first-run flow has to prove.
   */
  projectsEmpty: boolean;
  /**
   * Hold every GraphQL response for this many ms.
   *
   * Busy state is, by definition, only observable while a request is in flight. Against
   * an instant fixture that window is a few milliseconds and any assertion on it is a
   * race, so a spec that means to check the spinner slows the API down first.
   */
  slowMs: number;
  /**
   * What the registry manifest endpoint answers, when it is not deciding for itself.
   *
   * 0 means the rules in server.ts apply: a repository named `nonexistent/*` is 401, a tag
   * starting `nope` is 404, and **everything else is 200**. That default is load-bearing —
   * several specs type a reference the form then checks, and a fixture that answered 404
   * by default would make a warning appear under fields those specs are not about.
   */
  registryStatus: number;
};

const DEFAULT_FAULTS: Faults = {
  registryStatus: 0,
  rateLimit: 0,
  unauthorized: 0,
  refreshFails: false,
  accessTokenTtl: 3600,
  deploymentsFail: false,
  volumeCreateFail: false,
  volumesFail: false,
  settingsFail: false,
  limitsFail: false,
  logPhase: "both",
  failureField: "error",
  deploymentEventsFail: false,
  projectsSource: "personal",
  variablesFail: false,
  domainFails: false,
  metricsFail: false,
  workspaceFail: false,
  noWorkspace: false,
  rejectWorkspaces: false,
  rejectPersonal: false,
  projectsEmpty: false,
  slowMs: 0,
};

export type Project = {
  id: string;
  name: string;
  environments: Array<{ id: string; name: string }>;
};

/**
 * The seeded account, rebuilt per reset.
 *
 * A factory rather than a shared constant, and no longer a `readonly` field initialised
 * once: projects are mutable now that a spec can create one, so a run that seeded from a
 * shared array would leak the created project into every later spec — Playwright is
 * workers: 1 against one fixture process, so that leak is guaranteed rather than likely.
 */
const seedProjects = (): Project[] => [
  {
    id: "proj_demo",
    name: "Demo Project",
    environments: [
      { id: "env_prod", name: "production" },
      { id: "env_staging", name: "staging" },
    ],
  },
  {
    id: "proj_other",
    name: "Second Project",
    environments: [{ id: "env_other", name: "production" }],
  },
];

export class Store {
  projects: Project[] = seedProjects();

  services = new Map<string, Service>();
  deployments = new Map<string, Deployment>();
  volumes = new Map<string, Volume>();

  /**
   * Variables the environment sets for every service in it.
   *
   * Not a detail of the fixture: Railway's `variables` field answers what a service
   * *resolves*, shared entries included, and the edit form must not offer to delete one of
   * those — it could not honour the request, since `variableDelete` scoped to a service only
   * ever removes a service-scoped variable. The app subtracts this set from the other, and a
   * fixture without it would leave that subtraction untested and passing.
   */
  sharedVariables: Record<string, string> = { SHARED_TOKEN: "shared-value" };

  faults: Faults = { ...DEFAULT_FAULTS };

  #seq = 0;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    // A service this app did not create: the dashboard must show it read-only.
    this.addService({
      name: "postgres",
      projectId: "proj_demo",
      environmentId: "env_prod",
      image: "postgres:16",
      deployed: true,
    });
  }

  id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_${this.#seq}`;
  }

  addService(input: {
    name: string;
    projectId: string;
    environmentId: string;
    image: string | null;
    deployed?: boolean;
    /**
     * Pins the deployment at a status instead of letting it walk the progression.
     *
     * A filter spec needs a list holding several statuses at once and holding them
     * still; a deployment that advances every 400ms would move out from under the
     * assertion. Parked by setting `step` past the end of the progression, which is what
     * `tick()` already checks — so SLEEPING and REMOVED, which appear in no progression
     * at all, are expressible too.
     */
    status?: string;
    /** Seeds a service that is already reachable, for the row that must not offer a second. */
    domains?: string[];
  }): Service {
    const service: Service = {
      id: this.id("svc"),
      name: input.name,
      projectId: input.projectId,
      environmentId: input.environmentId,
      image: input.image,
      repo: null,
      createdAt: new Date(0).toISOString(),
      deploymentId: null,
      variables: {},
      domains: input.domains ?? [],
      settings: {
        region: null,
        replicas: null,
        restartPolicy: null,
        restartRetries: null,
        startCommand: null,
        vcpus: null,
        memoryGB: null,
      },
    };
    this.services.set(service.id, service);
    if (input.deployed || input.status) {
      const deployment = this.addDeployment(service.id);
      deployment.status = input.status ?? "SUCCESS";
      // Past the end, so tick() leaves it alone whatever progression it would have used.
      deployment.step = Math.max(PROGRESSION.length, FAILING_PROGRESSION.length);
    }
    return service;
  }

  /**
   * What `serviceDomainCreate` does here: a hostname derived from the service's name.
   *
   * Derived rather than random, because the specs assert on it — Railway's own hostnames are
   * `<service>-<environment>.up.railway.app`, and reproducing that shape is what lets a spec
   * check the row's link rather than merely that a link appeared.
   *
   * Appends, and deliberately does not refuse a service that already has one. The real API
   * mints a second domain here, and the app's guard against asking twice is in the action
   * rather than upstream — a fixture that refused would make that guard untestable by
   * quietly doing its job.
   */
  addServiceDomain(serviceId: string, environmentId: string): string | null {
    const service = this.services.get(serviceId);
    if (!service) return null;
    const environment = this.projects
      .flatMap((project) => project.environments)
      .find((candidate) => candidate.id === environmentId);
    const suffix = service.domains.length;
    const domain = `${service.name}-${environment?.name ?? "production"}${
      suffix === 0 ? "" : `-${suffix}`
    }.up.railway.app`;
    service.domains.push(domain);
    return domain;
  }

  addDeployment(serviceId: string): Deployment {
    const deployment: Deployment = {
      id: this.id("dep"),
      serviceId,
      status: "QUEUED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date(0).toISOString(),
      logs: { build: [], deploy: [] },
      events: [],
      step: 0,
      failing: this.faults.deploymentsFail,
      // Snapshotted, like `failing`: a spec that flips the fault afterwards is describing
      // the next deployment, not rewriting the history of this one.
      logPhase: this.faults.logPhase,
    };
    this.deployments.set(deployment.id, deployment);
    const service = this.services.get(serviceId);
    if (service) service.deploymentId = deployment.id;
    return deployment;
  }

  /**
   * What `deploymentStop` does here: the deployment settles at REMOVED and stays there.
   *
   * REMOVED rather than SLEEPING, because that is what Railway's own dashboard shows for a
   * deployment that was stopped — SLEEPING is its app-sleep feature, which this app does
   * not turn on. Both are terminal in the app's state machine either way, so the stream
   * closes rather than polling on; that is the property the fixture is here to exercise.
   *
   * The service survives, which is the whole difference from ServiceDelete: its row stays
   * on the dashboard, and redeploying it is what a spec goes on to do next.
   */
  stopDeployment(deploymentId: string): Deployment | null {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) return null;
    deployment.status = "REMOVED";
    deployment.updatedAt = new Date().toISOString();
    // Past the end of both progressions, so tick() leaves it where it was put.
    deployment.step = Math.max(PROGRESSION.length, FAILING_PROGRESSION.length);
    return deployment;
  }

  /**
   * What `deploymentRestart` does here: the same deployment walks back to DEPLOYING and
   * the ticker carries it to SUCCESS again, writing fresh log lines on the way.
   *
   * The id does not change, which is the property under test — a log pane already open on
   * this deployment must keep streaming rather than be left on a deployment nobody is
   * watching. A fixture that minted a new id here could not tell the two apart.
   */
  restartDeployment(deploymentId: string): Deployment | null {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) return null;
    deployment.status = "DEPLOYING";
    deployment.updatedAt = new Date().toISOString();
    // One before SUCCESS, so the next tick settles it and the transition is observable.
    deployment.step = PROGRESSION.indexOf("DEPLOYING");
    return deployment;
  }

  /** Advances every in-flight deployment one step and appends a log line. */
  tick(): void {
    for (const deployment of this.deployments.values()) {
      const progression = deployment.failing ? FAILING_PROGRESSION : PROGRESSION;
      if (deployment.step >= progression.length - 1) continue;

      deployment.step += 1;
      deployment.status = progression[deployment.step]!;
      deployment.updatedAt = new Date().toISOString();

      const line: LogLine = {
        timestamp: new Date().toISOString(),
        message: `[fake-railway] ${deployment.status.toLowerCase()} ${deployment.id}`,
        /*
         * Three values, so the filter has something to choose between rather than a single
         * chip that narrows to everything — and so the pane's severity COLOURING has more
         * than one tone on screen at once. `error` and `warn` map to different tokens;
         * `info` deliberately maps to none, which is the case that must keep reading as
         * ordinary output.
         */
        severity:
          deployment.status === "FAILED"
            ? "error"
            : deployment.status === "DEPLOYING"
              ? "warn"
              : "info",
      };
      if (deployment.logPhase === "both" || deployment.logPhase === "build") {
        deployment.logs.build.push(line);
      }
      if (deployment.logPhase === "both" || deployment.logPhase === "deploy") {
        deployment.logs.deploy.push(line);
      }

      deployment.events.push(this.#eventFor(deployment.status));
    }
  }

  /**
   * The deployment event a status transition produces.
   *
   * Only the terminal FAILED event carries text; the ones before it are all-null. That is
   * what makes the app's "walk backwards to the newest event with text" behaviour
   * observable — with a one-element feed it would be satisfied by any implementation.
   */
  #eventFor(status: string): DeploymentEvent {
    const empty = { error: null, reason: null, detail: null, skipped: false };
    const step = STATUS_STEPS[status] ?? "BUILD_IMAGE";
    if (status !== "FAILED") return { step, payload: empty };

    const field = this.faults.failureField;
    if (field === "none") return { step, payload: empty };
    return { step, payload: { ...empty, [field]: FAILURE_TEXT } };
  }

  start(): void {
    this.#timer = setInterval(() => this.tick(), TICK_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  addProject(name: string): Project {
    const project: Project = {
      id: this.id("proj"),
      name,
      // Railway makes one alongside the project, and the whole create flow depends on it
      // arriving in the same response — see PROJECT_CREATE_MUTATION.
      environments: [{ id: this.id("env"), name: "production" }],
    };
    this.projects.push(project);
    return project;
  }

  addEnvironment(projectId: string, name: string): { id: string; name: string } | null {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return null;
    const environment = { id: this.id("env"), name };
    project.environments.push(environment);
    return environment;
  }

  reset(): void {
    this.services.clear();
    this.deployments.clear();
    this.volumes.clear();
    this.projects = seedProjects();
    this.faults = { ...DEFAULT_FAULTS };
    this.sharedVariables = { SHARED_TOKEN: "shared-value" };
    this.addService({
      name: "postgres",
      projectId: "proj_demo",
      environmentId: "env_prod",
      image: "postgres:16",
      deployed: true,
    });
  }

  servicesIn(projectId: string): Service[] {
    return [...this.services.values()].filter((s) => s.projectId === projectId);
  }

  /**
   * Attach a volume to a service, the way `volumeCreate` does.
   *
   * The name is derived from the service's rather than passed in, because that is the
   * Railway behaviour the app now depends on: a service called `spun-pg` gets a volume
   * called `spun-pg-volume`, which is how the ownership prefix reaches the volume without
   * the app renaming anything. A fixture that let the caller choose would leave that
   * untested and passing. See ADR-13.
   *
   * `sizeMB: 500` is Railway's observed plan default, and `currentSizeMB: 0` is what an
   * unwritten volume answers — both fixed rather than random so a spec can assert the
   * rendered figure instead of a regex, the same rule `metricsFor` follows.
   */
  addVolume(input: {
    projectId: string;
    environmentId: string;
    serviceId: string;
    mountPath: string;
  }): Volume {
    const service = this.services.get(input.serviceId);
    const volume: Volume = {
      id: this.id("vol"),
      instanceId: this.id("volinst"),
      name: `${service?.name ?? "volume"}-volume`,
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
      mountPath: input.mountPath,
      sizeMB: 500,
      currentSizeMB: 0,
    };
    this.volumes.set(volume.id, volume);
    return volume;
  }

  volumesIn(environmentId: string): Volume[] {
    return [...this.volumes.values()].filter((v) => v.environmentId === environmentId);
  }

  /**
   * Detach a volume from a service that is going away, without deleting it.
   *
   * This is the behaviour probing the live API turned up and the whole reason destroy has a
   * choice to offer: `serviceDelete` does NOT cascade. The volume survives as billable
   * storage with a `serviceId` that no longer resolves, which is exactly the orphan the
   * mapper drops and the toast warns about.
   */
  orphanVolumesOf(serviceId: string): void {
    for (const volume of this.volumes.values()) {
      if (volume.serviceId === serviceId) volume.serviceId = null;
    }
  }

  /**
   * Current usage for one service.
   *
   * A deterministic function of the service id rather than Math.random, so a spec can
   * assert the rendered figure instead of a regex — the same reason the log lines are built
   * from the deployment id. A service that is not running reports nothing at all, which is
   * the case that has to reach the UI as an em dash rather than as a zero.
   */
  metricsFor(service: Service): { cpu: number; memory: number } | null {
    const deployment = service.deploymentId
      ? this.deployments.get(service.deploymentId)
      : undefined;
    if (deployment?.status !== "SUCCESS") return null;

    const n = Number(service.id.split("_")[1] ?? 0);
    return { cpu: 0.25 * ((n % 4) + 1), memory: 0.5 * ((n % 3) + 1) };
  }

  /** The workspace's billing state, as `Customer` exposes it. */
  customer(): { currentUsage: number; billingPeriod: { start: string; end: string } } {
    return {
      currentUsage: 18.4,
      billingPeriod: {
        start: "2026-08-01T00:00:00.000Z",
        end: "2026-08-31T00:00:00.000Z",
      },
    };
  }
}
