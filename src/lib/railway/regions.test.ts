import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REGIONS } from "@/lib/constants";
import type { RegionOption } from "./types";

/*
 * The API call is mocked rather than the transport, which is the level this module actually
 * works at: it decides how often `listRegions` is asked, and nothing about how that call is
 * made. A spy's call count is the whole assertion here — "the second read cost no round
 * trip" is a statement about this function, not about GraphQL.
 */
const listRegions = vi.fn<() => Promise<RegionOption[]>>();
vi.mock("./api", () => ({ listRegions: () => listRegions() }));

const { cachedRegions, __resetRegionCache } = await import("./regions");

const OREGON: RegionOption = {
  id: "us-west2",
  label: "US West (Oregon)",
  country: "United States",
};

beforeEach(() => {
  __resetRegionCache();
  listRegions.mockReset();
  listRegions.mockResolvedValue([OREGON]);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cachedRegions", () => {
  it("reads once and answers the second caller from memory", async () => {
    expect(await cachedRegions("token", "u1", "p1")).toEqual([OREGON]);
    expect(await cachedRegions("token", "u1", "p1")).toEqual([OREGON]);
    expect(listRegions).toHaveBeenCalledTimes(1);
  });

  it("reads again once the entry has expired", async () => {
    await cachedRegions("token", "u1", "p1");
    vi.advanceTimersByTime(REGIONS.TTL_MS + 1);
    await cachedRegions("token", "u1", "p1");
    expect(listRegions).toHaveBeenCalledTimes(2);
  });

  it("holds the entry right up to the expiry", async () => {
    await cachedRegions("token", "u1", "p1");
    vi.advanceTimersByTime(REGIONS.TTL_MS - 1);
    await cachedRegions("token", "u1", "p1");
    expect(listRegions).toHaveBeenCalledTimes(1);
  });

  it("keys by project, because availability is not established to be global", async () => {
    await cachedRegions("token", "u1", "p1");
    await cachedRegions("token", "u1", "p2");
    expect(listRegions).toHaveBeenCalledTimes(2);
  });

  /*
   * The half that separates this cache from the registry's, which is shared across users on
   * purpose. `regions(projectId)` is read with the caller's own token and Railway's `Region`
   * carries a `workspaceId`, so one person's answer is not established to be another's.
   */
  it("keys by user, so one session's answer is never served to another", async () => {
    await cachedRegions("token", "u1", "p1");
    await cachedRegions("other", "u2", "p1");
    expect(listRegions).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest-written first once the ceiling is reached", async () => {
    for (let index = 0; index <= REGIONS.CACHE_MAX_ENTRIES; index += 1) {
      await cachedRegions("token", "u1", `p${index}`);
    }
    const reads = listRegions.mock.calls.length;

    // The first key written is the one evicted, so asking for it again costs a read.
    await cachedRegions("token", "u1", "p0");
    expect(listRegions).toHaveBeenCalledTimes(reads + 1);

    // The most recent one is still resident.
    await cachedRegions("token", "u1", `p${REGIONS.CACHE_MAX_ENTRIES}`);
    expect(listRegions).toHaveBeenCalledTimes(reads + 1);
  });

  /*
   * A read that throws must leave nothing behind. The caller's answer to a failure is an
   * empty list and a disabled select — caching that for ten minutes would keep the choice
   * dark long after Railway recovered, which is the argument REGISTRY.UNKNOWN_TTL_MS makes
   * for its own shorter window.
   */
  it("caches nothing when the read fails", async () => {
    listRegions.mockRejectedValueOnce(new Error("nope"));
    await expect(cachedRegions("token", "u1", "p1")).rejects.toThrow();

    listRegions.mockResolvedValue([OREGON]);
    expect(await cachedRegions("token", "u1", "p1")).toEqual([OREGON]);
    expect(listRegions).toHaveBeenCalledTimes(2);
  });
});
