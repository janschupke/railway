import { describe, expect, it } from "vitest";
import {
  nodes,
  sortContainers,
  toContainer,
  toContainerMetrics,
  toContainerVolumes,
  toContainers,
  toDeploymentHistory,
  toProject,
  toRegionOptions,
  toWorkspaceSpend,
  toWorkspaces,
} from "./mappers";
import type {
  DeploymentHistoryNode,
  MetricsResultNode,
  RegionNode,
  ServiceNode,
  VolumeInstanceNode,
} from "./mappers";
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

describe("toWorkspaces", () => {
  it("names each workspace a project could be created in", () => {
    expect(
      toWorkspaces({
        id: "u1",
        workspaces: [
          { id: "ws2", name: "Beta" },
          { id: "ws1", name: "Acme" },
        ],
      }),
    ).toEqual([
      { id: "ws1", name: "Acme" },
      { id: "ws2", name: "Beta" },
    ]);
  });

  it("drops a workspace with no name, which could only render as a blank row", () => {
    expect(
      toWorkspaces({
        id: "u1",
        workspaces: [
          { id: "ws1", name: null },
          { id: "ws2", name: "Acme" },
        ],
      }),
    ).toEqual([{ id: "ws2", name: "Acme" }]);
  });

  it("reads a refused or absent workspace list as none", () => {
    // Both spellings arrive: `null` from a refused field, absent from the document that
    // does not select workspaces at all.
    expect(toWorkspaces({ id: "u1", workspaces: null })).toEqual([]);
    expect(toWorkspaces({ id: "u1" })).toEqual([]);
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

describe("toDeploymentHistory", () => {
  const node = (over: Partial<DeploymentHistoryNode> = {}): DeploymentHistoryNode => ({
    id: "d",
    status: "SUCCESS",
    createdAt: "2026-01-01T00:00:00Z",
    canRollback: true,
    ...over,
  });

  it("orders newest first, whatever order the connection arrived in", () => {
    /*
     * The reason this is sorted rather than trusted: `last` is asked for on one observation
     * about Railway's Relay ordering, and an ordering that changed would otherwise offer
     * the wrong ten deployments to roll back to.
     */
    const entries = toDeploymentHistory([
      node({ id: "middle", createdAt: "2026-01-02T00:00:00Z" }),
      node({ id: "oldest", createdAt: "2026-01-01T00:00:00Z" }),
      node({ id: "newest", createdAt: "2026-01-03T00:00:00Z" }),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("sorts an entry with no timestamp last rather than dropping it", () => {
    // The panel renders it; a deployment Railway will not date is still one that exists.
    const entries = toDeploymentHistory([
      node({ id: "undated", createdAt: null }),
      node({ id: "dated", createdAt: "2026-01-01T00:00:00Z" }),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["dated", "undated"]);
  });

  it("keeps Railway's own status beside the state derived from it", () => {
    const [entry] = toDeploymentHistory([node({ status: "CRASHED" })]);

    // The badge's title shows Railway's member; the state it maps onto is coarser.
    expect(entry).toMatchObject({ state: "failed", rawStatus: "CRASHED" });
  });

  it("maps a status it has never seen without losing it", () => {
    // Same trade toContainerState makes everywhere: an unknown member degrades the state
    // and the raw value survives for the badge's title.
    const [entry] = toDeploymentHistory([node({ status: "NOT_A_REAL_STATUS" })]);

    expect(entry?.rawStatus).toBe("NOT_A_REAL_STATUS");
    expect(entry?.state).toBe("unknown");
  });

  it("carries Railway's rollback answer rather than deriving one", () => {
    // `canRollback` is Railway's, not a rule computed here — see DeploymentHistoryEntry.
    const entries = toDeploymentHistory([
      node({ id: "a", canRollback: false, createdAt: "2026-01-02T00:00:00Z" }),
      node({ id: "b", canRollback: true, createdAt: "2026-01-01T00:00:00Z" }),
    ]);

    expect(entries.map((entry) => entry.canRollback)).toEqual([false, true]);
  });

  it("is empty for a service that has never deployed", () => {
    expect(toDeploymentHistory([])).toEqual([]);
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
        cpuLimitCores: null,
        memoryLimitGb: null,
        sampledAt: 1_760_000_000,
      },
      svc_2: {
        serviceId: "svc_2",
        cpuCores: 1.5,
        memoryGb: null,
        cpuLimitCores: null,
        memoryLimitGb: null,
        sampledAt: 1_760_000_000,
      },
    });
  });

  it("reads the ceilings out of the same response as the usage", () => {
    /*
     * All four figures a live probe returned for one real service. They arrive as ordinary
     * measurement series beside the usage ones, which is what makes the denominator on each
     * row free: one request, one `measurements` variable, no second round trip.
     *
     * 0.99999744 is Railway's own answer for a one-gigabyte limit. Not tidied up here, because
     * that raw value is what the readout has to render as "1.0 GB".
     */
    const metrics = toContainerMetrics([
      result({ values: [{ ts: 1_760_000_060, value: 0.00019975 }] }),
      result({
        measurement: "MEMORY_USAGE_GB",
        values: [{ ts: 1_760_000_060, value: 0.0353 }],
      }),
      result({
        measurement: "CPU_LIMIT",
        values: [{ ts: 1_760_000_060, value: 2 }],
      }),
      result({
        measurement: "MEMORY_LIMIT_GB",
        values: [{ ts: 1_760_000_060, value: 0.99999744 }],
      }),
    ]);

    expect(metrics.svc_1).toEqual({
      serviceId: "svc_1",
      cpuCores: 0.00019975,
      memoryGb: 0.0353,
      cpuLimitCores: 2,
      memoryLimitGb: 0.99999744,
      sampledAt: 1_760_000_060,
    });
  });

  it("reports a ceiling with no reading beside it, rather than dropping the service", () => {
    // The limit series is constant and outlives the usage one, so this pair is real rather
    // than guarded against on principle. The component renders the em dash and omits the
    // denominator — a ceiling alone says nothing about whether the container is running.
    const metrics = toContainerMetrics([
      result({ measurement: "CPU_LIMIT", values: [{ ts: 1_760_000_060, value: 2 }] }),
    ]);

    expect(metrics.svc_1).toEqual({
      serviceId: "svc_1",
      cpuCores: null,
      memoryGb: null,
      cpuLimitCores: 2,
      memoryLimitGb: null,
      sampledAt: null,
    });
  });

  it("does not let a constant limit series advance the sample time", () => {
    /*
     * `sampledAt` says when the USAGE was read. A limit series carries timestamps too — and
     * newer ones, since it is reported whether or not the container is running — so letting
     * one move this would make the field quietly stop meaning what its docblock says.
     */
    const metrics = toContainerMetrics([
      result({ values: [{ ts: 1_760_000_060, value: 0.25 }] }),
      result({
        measurement: "CPU_LIMIT",
        values: [{ ts: 1_760_000_300, value: 2 }],
      }),
    ]);

    expect(metrics.svc_1?.sampledAt).toBe(1_760_000_060);
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

  it("drops the aggregate row Railway sends beside the per-service ones", () => {
    /*
     * Observed, not defensive. `pnpm probe:metrics` showed one extra result per measurement
     * with `tags.serviceId: null` and a single `{ts, value: 0}` point — an aggregate across
     * the grouping. Kept, it would file the whole project's usage under the empty key.
     *
     * Mixed in with real rows rather than tested alone, because that is how it arrives, and
     * the two services either side of it have to come through untouched.
     */
    const metrics = toContainerMetrics([
      result({
        tags: { serviceId: "svc_1" },
        values: [{ ts: 1_760_000_060, value: 0.25 }],
      }),
      result({ tags: { serviceId: null }, values: [{ ts: 1_760_000_060, value: 0 }] }),
      result({
        tags: { serviceId: "svc_2" },
        values: [{ ts: 1_760_000_060, value: 1.5 }],
      }),
    ]);

    expect(Object.keys(metrics)).toEqual(["svc_1", "svc_2"]);
    expect(metrics.svc_1?.cpuCores).toBe(0.25);
    expect(metrics.svc_2?.cpuCores).toBe(1.5);
  });

  it("skips a result with no tags at all", () => {
    // This one IS schema-derived rather than observed: `MetricTags` is nullable and nothing
    // has been seen to return it that way. The honest split from the case above.
    expect(toContainerMetrics([result({ tags: null })])).toEqual({});
  });

  it("ignores a measurement it did not ask for", () => {
    /*
     * CPU_USAGE_2 first, because it is the one someone will reach for: it exists on the
     * schema, sits beside CPU_USAGE, and reads like the newer of the two. A live probe showed
     * it returning an empty array, and api.integration.test.ts pins the request accordingly —
     * this asserts that even if one arrived, it would not be read as a CPU figure.
     *
     * Ignored rather than thrown, for the reason toContainerState gives for DeploymentStatus:
     * Railway adds enum members without notice, and one must not take the readout down.
     */
    expect(toContainerMetrics([result({ measurement: "CPU_USAGE_2" })])).toEqual({});
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

describe("toRegionOptions", () => {
  /**
   * The real shape, which is not what this fixture used to hold.
   *
   * It set `id` and `name` to the same string, so every assertion below passed whichever
   * field the mapper read — and the mapper read the wrong one for as long as it existed.
   * On the live API `id` is a *location* code shared by several rows (`ams` three times,
   * `sfo` three times) and `name` is the unique identifier the mutation accepts. A fixture
   * where the two agree cannot tell them apart, which is exactly why nothing caught it.
   */
  const region = (over: Partial<RegionNode> = {}): RegionNode => ({
    id: "ams",
    name: "europe-west4-drams3a",
    location: "EU West (Amsterdam)",
    country: "Netherlands",
    deploymentConstraints: null,
    ...over,
  });

  it("posts the identifier Railway accepts, not the airport code beside it", () => {
    /*
     * Sending `id` returned `true` from `serviceInstanceUpdate` and stored `null`: a
     * control that appeared to work and did nothing, on a field with no read-back in the
     * UI to contradict it. The label stays `location`, which is the sentence a person
     * reads rather than either identifier.
     */
    expect(toRegionOptions([region()])).toEqual([
      {
        value: "europe-west4-drams3a",
        label: "EU West (Amsterdam)",
        country: "Netherlands",
      },
    ]);
  });

  it("offers every datacentre at one airport rather than collapsing them", () => {
    // Three rows come back as `ams` on the live API. Keyed on `id`, two of them would have
    // been three ways of spelling one option; keyed on `name`, they are three choices.
    const listed = toRegionOptions([
      region({ name: "europe-west4-drams3a" }),
      region({ name: "europe-west4-drams3a2" }),
      region({ name: "europe-west4-drams3a3" }),
    ]);

    expect(listed.map((option) => option.value)).toHaveLength(3);
    expect(new Set(listed.map((option) => option.value)).size).toBe(3);
  });

  it("keeps a region whose airport code Railway left null", () => {
    /*
     * `id` is nullable on the live schema and `name` is not, so a row with no code used to
     * be dropped — correctly, while `id` was the submitted value, because an option posting
     * the empty string reads as "let Railway choose" rather than as the choice the person
     * made. Reading `name` makes that row perfectly usable, and dropping it would be
     * withholding a datacentre for a field the app no longer sends.
     */
    expect(toRegionOptions([region({ id: null })])).toEqual([
      {
        value: "europe-west4-drams3a",
        label: "EU West (Amsterdam)",
        country: "Netherlands",
      },
    ]);
  });

  /*
   * Railway carries a replacement region beside the flag, so a deprecated one is a
   * datacentre with an end date. Offering it is offering a container that stops working
   * later, at a moment nothing in this app will explain.
   */
  it("drops a deprecated region", () => {
    const retiring = region({
      name: "europe-west4-drams3a-old",
      location: "EU West (old)",
      deploymentConstraints: {
        deprecationInfo: { isDeprecated: true },
      },
    });
    expect(toRegionOptions([retiring, region()]).map((option) => option.value)).toEqual(
      ["europe-west4-drams3a"],
    );
  });

  it("keeps a region whose constraints say nothing about deprecation", () => {
    const constrained = region({
      deploymentConstraints: { deprecationInfo: null },
    });
    expect(toRegionOptions([constrained])).toHaveLength(1);
  });

  // Country first, because it is the optgroup heading and an unsorted list repeats headings.
  it("sorts by country and then by label", () => {
    const listed = toRegionOptions([
      region({
        name: "us-east4-eqdc4a",
        location: "US East",
        country: "United States",
      }),
      region({
        name: "europe-west4-drams3a",
        location: "Amsterdam",
        country: "Netherlands",
      }),
      region({
        name: "us-west2-xrhvwla",
        location: "US West",
        country: "United States",
      }),
    ]);
    expect(listed.map((option) => option.value)).toEqual([
      "europe-west4-drams3a",
      "us-east4-eqdc4a",
      "us-west2-xrhvwla",
    ]);
  });
});
