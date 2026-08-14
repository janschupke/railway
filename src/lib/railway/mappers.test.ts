import { describe, expect, it } from "vitest";
import {
  nodes,
  sortContainers,
  toContainer,
  toContainerMetrics,
  toContainerVolumes,
  toContainers,
  toProject,
  toWorkspaceSpend,
} from "./mappers";
import type { MetricsResultNode, ServiceNode, VolumeInstanceNode } from "./mappers";
import type { Container } from "./types";

const service = (overrides: Partial<ServiceNode> = {}): ServiceNode => ({
  id: "svc_1",
  name: "spun-cache",
  createdAt: "2026-08-01T10:00:00Z",
  serviceInstances: {
    edges: [
      {
        node: {
          id: "si_1",
          environmentId: "env_1",
          source: { image: "redis:7-alpine", repo: null },
          latestDeployment: {
            id: "dep_1",
            status: "SUCCESS",
            createdAt: "2026-08-01T10:00:00Z",
            updatedAt: "2026-08-01T10:05:00Z",
          },
        },
      },
    ],
  },
  ...overrides,
});

/** The same service, with the domains Railway would have answered for it. */
const withDomains = (hosts: string[]): Container => {
  const base = service();
  const instance = base.serviceInstances!.edges[0]!.node;
  const mapped = toContainer(
    {
      ...base,
      serviceInstances: {
        edges: [
          {
            node: {
              ...instance,
              domains: { serviceDomains: hosts.map((domain) => ({ domain })) },
            },
          },
        ],
      },
    },
    "env_1",
  );
  if (!mapped) throw new Error("the fixture service is in env_1");
  return mapped;
};

describe("nodes", () => {
  it("unwraps a Relay connection", () => {
    expect(nodes({ edges: [{ node: 1 }, { node: 2 }] })).toEqual([1, 2]);
  });

  it("treats a missing connection as empty rather than throwing", () => {
    expect(nodes(null)).toEqual([]);
    expect(nodes(undefined)).toEqual([]);
  });
});

describe("toProject", () => {
  it("flattens environments", () => {
    expect(
      toProject({
        id: "p1",
        name: "Demo",
        environments: { edges: [{ node: { id: "e1", name: "production" } }] },
      }),
    ).toEqual({
      id: "p1",
      name: "Demo",
      environments: [{ id: "e1", name: "production" }],
    });
  });
});

describe("toContainer", () => {
  it("maps a service in the selected environment", () => {
    const container = toContainer(service(), "env_1");
    expect(container).toMatchObject({
      serviceId: "svc_1",
      rawName: "spun-cache",
      displayName: "cache",
      image: "redis:7-alpine",
      state: "running",
      deploymentId: "dep_1",
      managed: true,
    });
  });

  it("returns null when the service is absent from that environment", () => {
    // A project's services span environments; only the selected one is shown.
    expect(toContainer(service(), "env_other")).toBeNull();
  });

  it("marks services created outside this app as unmanaged", () => {
    // The safety property: ownership is derived here and nowhere else.
    const container = toContainer(service({ name: "postgres" }), "env_1");
    expect(container?.managed).toBe(false);
    expect(container?.displayName).toBe("postgres");
  });

  it("survives a service with no deployment yet", () => {
    const container = toContainer(
      service({
        serviceInstances: {
          edges: [
            {
              node: {
                id: "si_1",
                environmentId: "env_1",
                source: null,
                latestDeployment: null,
              },
            },
          ],
        },
      }),
      "env_1",
    );

    expect(container).toMatchObject({
      state: "unknown",
      deploymentId: null,
      image: null,
      repo: null,
    });
  });

  it("has no url when the service carries no domain", () => {
    expect(toContainer(service(), "env_1")?.url).toBeNull();
  });

  it("builds an https url from the domain Railway minted", () => {
    // The domain arrives as a bare host; the scheme is added here and nowhere downstream,
    // because Railway terminates TLS for every domain it mints.
    expect(withDomains(["spun-web-production.up.railway.app"]).url).toBe(
      "https://spun-web-production.up.railway.app",
    );
  });

  /*
   * The reason this is sorted rather than `[0]`. Railway documents no ordering for the list,
   * and a service can hold several domains — one per target port, plus any the user added in
   * Railway's own dashboard. Reading whichever end the response happened to put first means
   * two polls of an unchanged service disagree, which flips the watch fingerprint and wakes
   * every open tab on a change that did not happen.
   */
  it("picks the same domain however Railway orders them", () => {
    const forwards = withDomains(["a.up.railway.app", "z.up.railway.app"]);
    const backwards = withDomains(["z.up.railway.app", "a.up.railway.app"]);

    expect(forwards.url).toBe("https://a.up.railway.app");
    expect(backwards.url).toEqual(forwards.url);
  });

  /*
   * `AllDomains!` is non-null on the schema, so neither of these is a shape Railway should
   * send. They are what a partial or malformed body looks like to a mapper, and the answer
   * is the same as no domain rather than a throw that would take the whole list down.
   */
  it("survives a response that carries no domains field, or an empty one", () => {
    expect(toContainer(service(), "env_1")?.url).toBeNull();
    expect(withDomains([]).url).toBeNull();
  });
});

describe("sortContainers", () => {
  const make = (over: Partial<Container>): Container => ({
    serviceId: "s",
    rawName: "n",
    displayName: "n",
    image: null,
    repo: null,
    state: "running",
    rawStatus: null,
    deploymentId: null,
    createdAt: null,
    updatedAt: null,
    deployedAt: null,
    url: null,
    managed: false,
    ...over,
  });

  it("puts actionable containers first, then newest", () => {
    const sorted = sortContainers([
      make({ serviceId: "a", managed: false, createdAt: "2026-01-03" }),
      make({ serviceId: "b", managed: true, createdAt: "2026-01-01" }),
      make({ serviceId: "c", managed: true, createdAt: "2026-01-02" }),
    ]);

    expect(sorted.map((c) => c.serviceId)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate its input", () => {
    const input = [
      make({ serviceId: "a", managed: false }),
      make({ serviceId: "b", managed: true }),
    ];
    sortContainers(input);
    expect(input.map((c) => c.serviceId)).toEqual(["a", "b"]);
  });
});

describe("toContainers", () => {
  it("drops services from other environments and sorts the rest", () => {
    const result = toContainers(
      [service(), service({ id: "svc_2", name: "postgres" })],
      "env_1",
    );
    expect(result.map((c) => c.rawName)).toEqual(["spun-cache", "postgres"]);
  });
});

const result = (over: Partial<MetricsResultNode> = {}): MetricsResultNode => ({
  measurement: "CPU_USAGE",
  tags: { serviceId: "svc_1" },
  values: [{ ts: 1_760_000_000, value: 0.25 }],
  ...over,
});

describe("toContainerMetrics", () => {
  it("pivots measurement-major results into one entry per service", () => {
    // Railway answers per (measurement, service); the UI asks per row. The pivot lives here
    // so the numbers cross the RSC boundary in the shape they are read in.
    const metrics = toContainerMetrics([
      result(),
      result({
        measurement: "MEMORY_USAGE_GB",
        values: [{ ts: 1_760_000_000, value: 0.5 }],
      }),
      result({
        tags: { serviceId: "svc_2" },
        values: [{ ts: 1_760_000_000, value: 1.5 }],
      }),
    ]);

    expect(metrics).toEqual({
      svc_1: {
        serviceId: "svc_1",
        cpuCores: 0.25,
        memoryGb: 0.5,
        sampledAt: 1_760_000_000,
      },
      svc_2: {
        serviceId: "svc_2",
        cpuCores: 1.5,
        memoryGb: null,
        sampledAt: 1_760_000_000,
      },
    });
  });

  it("takes the newest sample rather than the last one in the array", () => {
    /*
     * Railway documents no ordering guarantee, and the one number rendered is the current
     * one — reading the wrong end of an unspecified order shows a five-minute-old figure
     * that looks exactly like a correct one.
     */
    const metrics = toContainerMetrics([
      result({
        values: [
          { ts: 1_760_000_120, value: 0.9 },
          { ts: 1_760_000_060, value: 0.1 },
        ],
      }),
    ]);

    expect(metrics.svc_1?.cpuCores).toBe(0.9);
    expect(metrics.svc_1?.sampledAt).toBe(1_760_000_120);
  });

  it("leaves a service with no samples absent rather than reporting it as zero", () => {
    /*
     * The distinction the whole readout rests on. An empty series is ordinary — a stopped
     * service produces none — and "0.00 vCPU" would claim the container is running and idle,
     * which is a statement about someone's bill. Absent renders as an em dash instead.
     */
    expect(toContainerMetrics([result({ values: [] })])).toEqual({});
    expect(toContainerMetrics([result({ values: null })])).toEqual({});
  });

  it("skips a result that names no service", () => {
    // MetricTags.serviceId is nullable on the live schema, and a result with none is one
    // this app has no row to put anywhere.
    expect(toContainerMetrics([result({ tags: { serviceId: null } })])).toEqual({});
    expect(toContainerMetrics([result({ tags: null })])).toEqual({});
  });

  it("ignores a measurement it did not ask for", () => {
    // Railway adds enum members without notice — the same reasoning toContainerState gives
    // for DeploymentStatus. An unknown one must not take the readout down with it.
    expect(toContainerMetrics([result({ measurement: "NETWORK_RX_GB" })])).toEqual({});
  });

  it("returns nothing at all for an empty response", () => {
    expect(toContainerMetrics([])).toEqual({});
  });
});

describe("toContainerVolumes", () => {
  const instance = (over: Partial<VolumeInstanceNode> = {}): VolumeInstanceNode => ({
    id: "volinst_1",
    volumeId: "vol_1",
    serviceId: "svc_1",
    mountPath: "/var/lib/postgresql/data",
    sizeMB: 500,
    currentSizeMB: 12,
    ...over,
  });

  it("keys on the service the volume is mounted on", () => {
    expect(toContainerVolumes([instance()])).toEqual({
      svc_1: {
        serviceId: "svc_1",
        volumeId: "vol_1",
        mountPath: "/var/lib/postgresql/data",
        sizeMB: 500,
        currentSizeMB: 12,
      },
    });
  });

  it("drops an orphan, which is what a kept volume becomes", () => {
    /*
     * `serviceId` is nullable on the schema and a volume outlives its service — which is
     * precisely the state a destroy leaves behind when the user chooses to keep the data.
     * Real, billable, and not something this app has a surface for: it lists containers.
     */
    expect(toContainerVolumes([instance({ serviceId: null })])).toEqual({});
  });

  it("keeps the first of several on one service", () => {
    // Railway permits more than one; this app creates exactly one. A row that offers a
    // single mount path must not describe a service that has two.
    const volumes = toContainerVolumes([
      instance({ volumeId: "vol_first" }),
      instance({ id: "volinst_2", volumeId: "vol_second", mountPath: "/other" }),
    ]);
    expect(volumes.svc_1?.volumeId).toBe("vol_first");
  });

  it("returns nothing at all for an empty response", () => {
    // Which is also what a refused read degrades to — and every consequence of the empty
    // answer is the conservative one: no readout, no checkbox, and destroy keeps the data.
    expect(toContainerVolumes([])).toEqual({});
  });
});

describe("toWorkspaceSpend", () => {
  const workspace = {
    id: "ws_1",
    name: "Acme",
    customer: {
      currentUsage: 18.4,
      billingPeriod: { start: "2026-08-01T00:00:00Z", end: "2026-08-31T00:00:00Z" },
    },
  };

  it("maps a workspace that answered", () => {
    expect(toWorkspaceSpend(workspace)).toEqual({
      currentUsage: 18.4,
      periodStart: "2026-08-01T00:00:00Z",
      periodEnd: "2026-08-31T00:00:00Z",
      workspaceName: "Acme",
    });
  });

  it("is null for a personal project, which belongs to no workspace", () => {
    // Project.workspace is nullable on the live schema. This is an ordinary state, not a
    // failure, and the UI renders the same "it is over there" note it renders for a refusal.
    expect(toWorkspaceSpend(null)).toBeNull();
  });

  it("is null when the customer or its billing period was refused", () => {
    expect(toWorkspaceSpend({ id: "ws_1", name: "Acme", customer: null })).toBeNull();
    expect(
      toWorkspaceSpend({
        id: "ws_1",
        name: "Acme",
        customer: { currentUsage: 18.4, billingPeriod: null },
      }),
    ).toBeNull();
  });

  it("keeps the figure when only the workspace name is missing", () => {
    // The name is decoration — the copy falls back to "this project's workspace" — and
    // dropping a real spend figure over a missing label would be the wrong trade.
    expect(toWorkspaceSpend({ ...workspace, name: null })?.workspaceName).toBeNull();
  });
});
