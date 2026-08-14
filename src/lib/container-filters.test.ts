import { describe, expect, it } from "vitest";
import {
  filterContainers,
  filterKey,
  filterQueryString,
  hasActiveFilters,
  NO_FILTERS,
  parseFilters,
  type ContainerFilters,
} from "./container-filters";
import { LIST } from "./constants";
import type { Container } from "./railway/types";

const container = (overrides: Partial<Container> = {}): Container => ({
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
  managed: true,
  ...overrides,
});

const params = (search: string) => new URLSearchParams(search);
const filters = (overrides: Partial<ContainerFilters> = {}): ContainerFilters => ({
  ...NO_FILTERS,
  ...overrides,
});

describe("parseFilters", () => {
  it("treats absent params as no constraint", () => {
    expect(parseFilters(params(""))).toEqual(NO_FILTERS);
  });

  it("reads the comma form and the repeated form identically", () => {
    expect(parseFilters(params("status=running,failed"))).toEqual(
      parseFilters(params("status=running&status=failed")),
    );
  });

  it("orders statuses canonically, however they were written", () => {
    expect(parseFilters(params("status=failed,building")).statuses).toEqual([
      "building",
      "failed",
    ]);
  });

  it("dedupes repeated members", () => {
    expect(parseFilters(params("status=running,running")).statuses).toEqual([
      "running",
    ]);
  });

  it("drops an unrecognised status and keeps its valid siblings", () => {
    // A link naming a state this build no longer maps must narrow oddly, never blank.
    expect(parseFilters(params("status=running,teleporting")).statuses).toEqual([
      "running",
    ]);
  });

  it("is case-insensitive", () => {
    expect(parseFilters(params("status=RUNNING&owner=CREATED"))).toMatchObject({
      statuses: ["running"],
      owners: ["created"],
    });
  });

  it("trims, collapses and caps the query", () => {
    expect(parseFilters(params("q=  web%20%20server ")).query).toBe("web server");
    expect(parseFilters(params(`q=${"a".repeat(200)}`)).query).toHaveLength(
      LIST.QUERY_MAX,
    );
  });

  it("treats a blank query as absent", () => {
    expect(parseFilters(params("q=%20%20")).query).toBe("");
  });

  it("ignores an unrecognised owner", () => {
    expect(parseFilters(params("owner=landlord")).owners).toEqual([]);
  });
});

describe("filterQueryString", () => {
  it("preserves the page's own params", () => {
    expect(
      filterQueryString(
        params("project=p1&environment=e1"),
        filters({ query: "redis" }),
      ),
    ).toBe("project=p1&environment=e1&q=redis");
  });

  it("omits empty groups entirely", () => {
    expect(filterQueryString(params("project=p1"), NO_FILTERS)).toBe("project=p1");
  });

  it("clears filter params that are no longer selected", () => {
    expect(
      filterQueryString(params("project=p1&q=old&status=failed"), NO_FILTERS),
    ).toBe("project=p1");
  });

  it("keeps commas literal rather than percent-encoded", () => {
    // Both forms parse back the same; this one is legible in the address bar.
    expect(
      filterQueryString(params(""), filters({ statuses: ["building", "failed"] })),
    ).toBe("status=building,failed");
  });

  it("round-trips through parseFilters", () => {
    const original = filters({
      query: "web server",
      statuses: ["building", "running"],
      owners: ["external"],
    });
    expect(parseFilters(params(filterQueryString(params(""), original)))).toEqual(
      original,
    );
  });
});

describe("filterContainers", () => {
  const cache = container({
    serviceId: "a",
    displayName: "cache",
    rawName: "spun-cache",
  });
  const db = container({
    serviceId: "b",
    displayName: "postgres",
    rawName: "postgres",
    image: "postgres:16",
    state: "failed",
    managed: false,
  });
  const api = container({
    serviceId: "c",
    displayName: "api",
    rawName: "spun-api",
    image: null,
    repo: "janschupke/railway",
    state: "building",
  });
  const all = [cache, db, api];
  const ids = (result: Container[]) => result.map((c) => c.serviceId);

  it("returns everything when nothing is selected", () => {
    expect(filterContainers(all, NO_FILTERS)).toEqual(all);
  });

  it("matches the display name case-insensitively", () => {
    expect(ids(filterContainers(all, filters({ query: "CACHE" })))).toEqual(["a"]);
  });

  it("matches the prefixed raw name, which the prefix note teaches", () => {
    expect(ids(filterContainers(all, filters({ query: "spun-" })))).toEqual(["a", "c"]);
  });

  it("matches the image", () => {
    expect(ids(filterContainers(all, filters({ query: "postgres:16" })))).toEqual([
      "b",
    ]);
  });

  it("matches the repo", () => {
    expect(ids(filterContainers(all, filters({ query: "janschupke" })))).toEqual(["c"]);
  });

  it("ORs the members of a group", () => {
    expect(
      ids(filterContainers(all, filters({ statuses: ["failed", "building"] }))),
    ).toEqual(["b", "c"]);
  });

  it("ANDs the groups together", () => {
    expect(
      ids(
        filterContainers(all, filters({ statuses: ["failed"], owners: ["created"] })),
      ),
    ).toEqual([]);
  });

  it("reads created as managed and external as its negation", () => {
    expect(ids(filterContainers(all, filters({ owners: ["created"] })))).toEqual([
      "a",
      "c",
    ]);
    expect(ids(filterContainers(all, filters({ owners: ["external"] })))).toEqual([
      "b",
    ]);
  });

  it("both owners selected is the same as neither", () => {
    expect(filterContainers(all, filters({ owners: ["created", "external"] }))).toEqual(
      all,
    );
  });

  it("preserves the incoming order", () => {
    expect(ids(filterContainers(all, filters({ query: "s" })))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("hasActiveFilters", () => {
  it("is false for the empty selection and true for any group", () => {
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
    expect(hasActiveFilters(filters({ query: "x" }))).toBe(true);
    expect(hasActiveFilters(filters({ statuses: ["running"] }))).toBe(true);
    expect(hasActiveFilters(filters({ owners: ["created"] }))).toBe(true);
  });
});

describe("filterKey", () => {
  it("is equal for selections that parse the same, whatever the URL order", () => {
    expect(filterKey(parseFilters(params("status=failed,building")))).toBe(
      filterKey(parseFilters(params("status=building&status=failed"))),
    );
  });

  it("changes when the selection changes", () => {
    expect(filterKey(filters({ query: "a" }))).not.toBe(
      filterKey(filters({ query: "b" })),
    );
  });
});
