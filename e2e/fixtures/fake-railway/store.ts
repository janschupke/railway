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
};

const DEFAULT_FAULTS: Faults = {
  rateLimit: 0,
  unauthorized: 0,
  refreshFails: false,
  accessTokenTtl: 3600,
  deploymentsFail: false,
  logPhase: "both",
  failureField: "error",
  deploymentEventsFail: false,
  projectsSource: "personal",
  variablesFail: false,
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

  addDeployment(serviceId: string): Deployment {
    const deployment: Deployment = {
      id: this.id("dep"),
      serviceId,
      status: "QUEUED",
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
        // Two values, so the filter has something to choose between rather than a single
        // chip that narrows to everything.
        severity: deployment.status === "FAILED" ? "error" : "info",
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
    this.projects = seedProjects();
    this.faults = { ...DEFAULT_FAULTS };
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
}
