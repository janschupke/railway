/**
 * In-memory Railway, just enough of it.
 *
 * Deployments advance QUEUED → BUILDING → DEPLOYING → SUCCESS on a timer so the UI's
 * status transitions and log streaming are exercised for real rather than asserted
 * against a frozen fixture.
 */

type LogLine = { timestamp: string; message: string };

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
  rejectViewer: boolean;
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
  projectsSource: "personal",
  variablesFail: false,
  rejectWorkspaces: false,
  rejectPersonal: false,
  rejectViewer: false,
  slowMs: 0,
};

export class Store {
  readonly projects = [
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
      };
      if (deployment.logPhase === "both" || deployment.logPhase === "build") {
        deployment.logs.build.push(line);
      }
      if (deployment.logPhase === "both" || deployment.logPhase === "deploy") {
        deployment.logs.deploy.push(line);
      }
    }
  }

  start(): void {
    this.#timer = setInterval(() => this.tick(), TICK_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  reset(): void {
    this.services.clear();
    this.deployments.clear();
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
