import { describe, expect, it } from "vitest";
import { nodes, sortContainers, toContainer, toContainers, toProject } from "./mappers";
import type { ServiceNode } from "./mappers";
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
