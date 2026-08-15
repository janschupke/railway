import { describe, expect, it } from "vitest";
import { sumContainerMetrics } from "./container-metrics";
import type { Container, ContainerMetrics } from "./railway/types";

const container = (over: Partial<Container> = {}): Container => ({
  serviceId: "svc_1",
  rawName: "spun-cache",
  displayName: "cache",
  image: "redis:7-alpine",
  repo: null,
  state: "running",
  rawStatus: "SUCCESS",
  deploymentId: "dep_1",
  createdAt: "2026-08-01T10:00:00Z",
  updatedAt: "2026-08-01T10:05:00Z",
  deployedAt: "2026-08-01T10:00:00Z",
  url: null,
  managed: true,
  ...over,
});

const usage = (over: Partial<ContainerMetrics> = {}): ContainerMetrics => ({
  serviceId: "svc_1",
  cpuCores: 0.25,
  memoryGb: 0.5,
  cpuLimitCores: 2,
  memoryLimitGb: 0.99999744,
  sampledAt: 1_760_000_000,
  ...over,
});

describe("sumContainerMetrics", () => {
  it("adds up the containers this app created", () => {
    const totals = sumContainerMetrics(
      [container(), container({ serviceId: "svc_2" })],
      {
        svc_1: usage(),
        svc_2: usage({ serviceId: "svc_2", cpuCores: 0.75, memoryGb: 1.5 }),
      },
    );

    expect(totals).toEqual({ cpuCores: 1, memoryGb: 2, containers: 2 });
  });

  it("excludes containers this app did not create", () => {
    /*
     * The scope the whole cost story rests on. A total that quietly included someone else's
     * services would be exactly the misreading the copy around it is written to prevent —
     * and it is the same `managed` flag the owner filter and the destroy gate key on.
     */
    const totals = sumContainerMetrics(
      [container(), container({ serviceId: "svc_2", managed: false })],
      {
        svc_1: usage(),
        svc_2: usage({ serviceId: "svc_2", cpuCores: 9, memoryGb: 9 }),
      },
    );

    expect(totals).toEqual({ cpuCores: 0.25, memoryGb: 0.5, containers: 1 });
  });

  it("skips a container Railway reported nothing for", () => {
    const totals = sumContainerMetrics(
      [container(), container({ serviceId: "svc_2" })],
      { svc_1: usage() },
    );

    expect(totals.containers).toBe(1);
    expect(totals.cpuCores).toBe(0.25);
  });

  it("totals nothing rather than zero when nothing answered", () => {
    /*
     * Absent is not zero. A project whose metrics were refused, or whose containers are all
     * stopped, sums to null — and "0.00 vCPU" would state that the infrastructure is running
     * and idle, which is a claim about someone's bill. Null renders as an em dash, which
     * states nothing.
     */
    expect(sumContainerMetrics([container()], {})).toEqual({
      cpuCores: null,
      memoryGb: null,
      containers: 0,
    });
  });

  it("keeps a real zero once something has answered", () => {
    // The mirror of the case above: a container genuinely idling at zero must not read as
    // "no data", or the two states collapse back into one.
    expect(
      sumContainerMetrics([container()], {
        svc_1: usage({ cpuCores: 0, memoryGb: 0 }),
      }),
    ).toEqual({ cpuCores: 0, memoryGb: 0, containers: 1 });
  });

  it("counts a container that answered on only one measurement", () => {
    // Half a reading is still a container the total covers; the other half stays absent.
    const totals = sumContainerMetrics([container()], {
      svc_1: usage({ memoryGb: null }),
    });

    expect(totals).toEqual({ cpuCores: 0.25, memoryGb: null, containers: 1 });
  });

  it("returns nothing for an empty list", () => {
    expect(sumContainerMetrics([], {})).toEqual({
      cpuCores: null,
      memoryGb: null,
      containers: 0,
    });
  });
});
