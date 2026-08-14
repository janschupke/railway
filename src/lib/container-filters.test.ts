import { describe, expect, it } from "vitest";
import {
  filterContainers,
  filterKey,
  filterQueryString,
  hasActiveFilters,
  NO_FILTERS,
  orderContainers,
  parseFilters,
  type ContainerFilters,
  type SortOrder,
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
  url: null,
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

describe("the sort in the URL", () => {
  it("defaults to the order Railway's answer already arrived in", () => {
    expect(parseFilters(params("")).sort).toBe("default");
  });

  it("reads a member it knows", () => {
    expect(parseFilters(params("sort=name-asc")).sort).toBe("name-asc");
  });

  it("falls back rather than blanking the list on a value it does not know", () => {
    // Same posture toContainerState takes towards an enum member this build lacks: a link
    // naming an order that no longer exists must read oddly, never fail.
    expect(parseFilters(params("sort=by-vibes")).sort).toBe("default");
  });

  it("writes no param for the default, so the plain list keeps a bare URL", () => {
    expect(filterQueryString(params(""), filters({ sort: "default" }))).toBe("");
  });

  it("writes the chosen order beside the filters and the page's own params", () => {
    expect(
      filterQueryString(
        params("project=p1"),
        filters({ query: "web", sort: "oldest" }),
      ),
    ).toBe("project=p1&q=web&sort=oldest");
  });

  it("is not a filter, so it does not arm Clear", () => {
    // A button labelled "Clear filters" that also reset the reading order would be copy
    // that lies; the write side of the same line lives in useContainerFilters.clear.
    expect(hasActiveFilters(filters({ sort: "newest" }))).toBe(false);
  });

  it("resets the page count, because it changes which rows the first page holds", () => {
    expect(filterKey(filters({ sort: "newest" }))).not.toBe(
      filterKey(filters({ sort: "oldest" })),
    );
  });
});

describe("orderContainers", () => {
  const listed = (containers: Container[], sort: SortOrder) =>
    orderContainers(containers, sort, "en").map((c) => c.displayName);

  const web = container({
    serviceId: "svc_b",
    displayName: "web",
    state: "failed",
    createdAt: "2026-08-02T00:00:00Z",
  });
  const api = container({
    serviceId: "svc_a",
    displayName: "api",
    state: "running",
    createdAt: "2026-08-03T00:00:00Z",
  });
  const db = container({
    serviceId: "svc_c",
    displayName: "db",
    state: "building",
    createdAt: "2026-08-01T00:00:00Z",
  });
  const all = [web, api, db];

  it("leaves the server's order alone, identity included", () => {
    /*
     * Not merely "returns the same names". A fresh array here would reach
     * useIncrementalList as a new `items` on every render of a page that refreshes itself
     * every few seconds.
     */
    expect(orderContainers(all, "default")).toBe(all);
  });

  it("sorts by name in both directions", () => {
    expect(listed(all, "name-asc")).toEqual(["api", "db", "web"]);
    expect(listed(all, "name-desc")).toEqual(["web", "db", "api"]);
  });

  it("sorts by state in lifecycle order rather than alphabetically", () => {
    // CONTAINER_STATES is already ordered as a deployment walks them, which is the order
    // worth reading: building sits before running, and running before failed.
    expect(listed(all, "state")).toEqual(["db", "api", "web"]);
  });

  it("sorts by when the service was created, in both directions", () => {
    expect(listed(all, "newest")).toEqual(["api", "web", "db"]);
    expect(listed(all, "oldest")).toEqual(["db", "web", "api"]);
  });

  it("puts a container with no creation date last, whichever way it is read", () => {
    /*
     * The one ordering that says the same thing in both directions: this app does not know
     * when this was made. Sorting a missing date as the epoch would make it the oldest
     * thing in the environment, which is a claim rather than an absence.
     */
    const undated = container({
      serviceId: "svc_z",
      displayName: "zed",
      createdAt: null,
    });
    expect(listed([undated, ...all], "newest").at(-1)).toBe("zed");
    expect(listed([undated, ...all], "oldest").at(-1)).toBe("zed");
  });

  it("settles a tie by service id rather than leaving it to the engine", () => {
    const same = (serviceId: string) =>
      container({ serviceId, displayName: "same", createdAt: "2026-08-01T00:00:00Z" });
    expect(
      orderContainers([same("svc_9"), same("svc_1")], "newest").map((c) => c.serviceId),
    ).toEqual(["svc_1", "svc_9"]);
  });

  it("does not sort in place", () => {
    const input = [...all];
    orderContainers(input, "name-asc");
    expect(input).toEqual(all);
  });
});
