import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REGISTRY } from "@/lib/constants";
import {
  __resetRegistryCache,
  coolingOff,
  readCache,
  startCoolOff,
  writeCache,
} from "./answer-cache";

beforeEach(() => {
  __resetRegistryCache();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readCache and writeCache", () => {
  it("answers a key it was given, and nothing for one it was not", () => {
    writeCache("docker.io/redis:7", "available");
    expect(readCache("docker.io/redis:7")).toBe("available");
    expect(readCache("docker.io/redis:8")).toBeNull();
  });

  it("holds an answer right up to the expiry, and drops it after", () => {
    writeCache("k", "available");
    vi.advanceTimersByTime(REGISTRY.ANSWER_TTL_MS - 1);
    expect(readCache("k")).toBe("available");

    vi.advanceTimersByTime(2);
    expect(readCache("k")).toBeNull();
  });

  it("keeps an unresolved answer for a much shorter window than a real one", () => {
    /*
     * The TTL split is the point of this cache. `unknown` means no verdict was reached — a
     * timeout, a refusal, a registry cooling off — and holding that for the full ten minutes
     * would keep an image marked unverifiable long after the registry recovered.
     */
    expect(REGISTRY.UNKNOWN_TTL_MS).toBeLessThan(REGISTRY.ANSWER_TTL_MS);

    writeCache("k", "unknown");
    vi.advanceTimersByTime(REGISTRY.UNKNOWN_TTL_MS + 1);
    expect(readCache("k")).toBeNull();

    writeCache("j", "unavailable");
    vi.advanceTimersByTime(REGISTRY.UNKNOWN_TTL_MS + 1);
    expect(readCache("j")).toBe("unavailable");
  });

  it("evicts least-recently-written, not least-recently-read", () => {
    // A re-write moves a key to the back of the insertion order; a read does not. Reading
    // kept a key alive, the eviction would follow attention rather than age.
    for (let i = 0; i <= REGISTRY.CACHE_MAX_ENTRIES; i += 1) {
      writeCache(`k${i}`, "available");
    }
    expect(readCache("k0")).toBeNull();
    expect(readCache(`k${REGISTRY.CACHE_MAX_ENTRIES}`)).toBe("available");
  });

  it("moves a refreshed key to the back rather than leaving it where it was", () => {
    writeCache("first", "available");
    for (let i = 0; i < REGISTRY.CACHE_MAX_ENTRIES - 1; i += 1) {
      writeCache(`k${i}`, "available");
    }
    // Refreshing `first` should save it from the eviction the next write triggers.
    writeCache("first", "available");
    writeCache("overflow", "available");

    expect(readCache("first")).toBe("available");
    expect(readCache("k0")).toBeNull();
  });
});

describe("coolingOff and startCoolOff", () => {
  it("is not cooling off a registry that has never failed", () => {
    expect(coolingOff("docker.io")).toBe(false);
  });

  it("holds a registry off for the window, then lets it go again", () => {
    startCoolOff("ghcr.io");
    expect(coolingOff("ghcr.io")).toBe(true);

    vi.advanceTimersByTime(REGISTRY.COOLOFF_MS - 1);
    expect(coolingOff("ghcr.io")).toBe(true);

    vi.advanceTimersByTime(2);
    expect(coolingOff("ghcr.io")).toBe(false);
  });

  it("cools off one registry without touching the others", () => {
    // Three independent hosts; one being slow says nothing about the other two.
    startCoolOff("quay.io");
    expect(coolingOff("quay.io")).toBe(true);
    expect(coolingOff("docker.io")).toBe(false);
    expect(coolingOff("ghcr.io")).toBe(false);
  });

  it("restarts the window on a second failure", () => {
    startCoolOff("docker.io");
    vi.advanceTimersByTime(REGISTRY.COOLOFF_MS - 1);
    startCoolOff("docker.io");

    vi.advanceTimersByTime(REGISTRY.COOLOFF_MS - 1);
    expect(coolingOff("docker.io")).toBe(true);
  });
});
