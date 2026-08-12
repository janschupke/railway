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

  faults: Faults = {
    rateLimit: 0,
    unauthorized: 0,
    refreshFails: false,
    accessTokenTtl: 3600,
    deploymentsFail: false,
  };

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
    this.faults = {
      rateLimit: 0,
      unauthorized: 0,
      refreshFails: false,
      accessTokenTtl: 3600,
      deploymentsFail: false,
    };
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
