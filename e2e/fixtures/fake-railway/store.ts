/**
 * In-memory Railway, just enough of it.
 *
 * Deployments advance QUEUED → BUILDING → DEPLOYING → SUCCESS on a timer so the UI's
 * status transitions and log streaming are exercised for real rather than asserted
 * against a frozen fixture.
 */

export type Deployment = {
  id: string;
  serviceId: string;
  status: string;
  updatedAt: string;
  logs: Array<{ timestamp: string; message: string }>;
  /** Index into PROGRESSION. */
  step: number;
  failing: boolean;
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
  projectsSource: "personal",
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
    };
    this.services.set(service.id, service);
    if (input.deployed) {
      const deployment = this.addDeployment(service.id);
      deployment.status = "SUCCESS";
      deployment.step = PROGRESSION.length - 1;
    }
    return service;
  }

  addDeployment(serviceId: string): Deployment {
    const deployment: Deployment = {
      id: this.id("dep"),
      serviceId,
      status: "QUEUED",
      updatedAt: new Date(0).toISOString(),
      logs: [],
      step: 0,
      failing: this.faults.deploymentsFail,
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
      deployment.logs.push({
        timestamp: new Date().toISOString(),
        message: `[fake-railway] ${deployment.status.toLowerCase()} ${deployment.id}`,
      });
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
