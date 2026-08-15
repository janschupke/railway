import { describe, expect, it } from "vitest";

import { STREAM } from "@/lib/constants";
import { RailwayApiError } from "./errors";
import { backoffFor, healthyInterval } from "./poll-cadence";

const rateLimited = (retryAfterSeconds?: number) =>
  new RailwayApiError("slow down", {
    kind: "rate_limit",
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

describe("healthyInterval", () => {
  it("stays at the base cadence for a deployment that keeps moving", () => {
    // A transition resets the counter, so a deployment that is progressing never leaves
    // the first rung however long it runs.
    expect(healthyInterval(0)).toBe(STREAM.STATUS_POLL_MS);
  });

  it("climbs the documented ladder, doubling once per escalation rung", () => {
    /*
     * constants.ts states the ladder as "2.5s ×4, 5s ×4, 10s ×4, then MAX_POLL_MS", and
     * until now nothing checked that the arithmetic produced it — the function was a closure
     * inside a 505-line generator, so the only way to observe a rung was to drive a fake
     * Railway through four polls and time the fifth.
     */
    const rung = (polls: number) => healthyInterval(polls);
    const step = STREAM.POLLS_BEFORE_ESCALATION;

    expect(rung(step - 1)).toBe(STREAM.STATUS_POLL_MS);
    expect(rung(step)).toBe(STREAM.STATUS_POLL_MS * 2);
    expect(rung(step * 2)).toBe(STREAM.STATUS_POLL_MS * 4);
  });

  it("never exceeds the ceiling, however long a deployment sits still", () => {
    expect(healthyInterval(1_000)).toBe(STREAM.MAX_POLL_MS);
    expect(healthyInterval(Number.MAX_SAFE_INTEGER)).toBe(STREAM.MAX_POLL_MS);
  });
});

describe("backoffFor", () => {
  it("doubles the interval it was called with", () => {
    expect(backoffFor(new Error("nope"), 1_000)).toBe(2_000);
  });

  it("waits out Railway's Retry-After when that is the longer wait", () => {
    // The only informed number in this system: the client has already spent its attempts
    // being told the same thing, so polling again inside the window buys nothing.
    expect(backoffFor(rateLimited(30), 1_000)).toBe(30_000);
  });

  it("keeps doubling when Retry-After is the shorter of the two", () => {
    expect(backoffFor(rateLimited(1), 5_000)).toBe(10_000);
  });

  it("ignores Retry-After on an error that is not a rate limit", () => {
    // `retryAfterSeconds` is only meaningful on the kind that sets it; reading it off any
    // RailwayApiError would let an unrelated failure dictate the cadence.
    const other = new RailwayApiError("boom", {
      kind: "server",
      retryAfterSeconds: 30,
    });
    expect(backoffFor(other, 1_000)).toBe(2_000);
  });

  it("treats a rate limit with no Retry-After as a plain doubling", () => {
    expect(backoffFor(rateLimited(), 1_000)).toBe(2_000);
  });

  it("clamps even a Retry-After, which is a hint rather than a mandate", () => {
    // A stream held open doing nothing is worse than asking again a minute later.
    expect(backoffFor(rateLimited(86_400), 1_000)).toBe(STREAM.MAX_BACKOFF_MS);
    expect(backoffFor(new Error("nope"), STREAM.MAX_BACKOFF_MS)).toBe(
      STREAM.MAX_BACKOFF_MS,
    );
  });
});
