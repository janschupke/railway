import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION, STREAM } from "@/lib/constants";
import { streamDurationMs } from "./stream-route";

describe("streamDurationMs", () => {
  const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
  const expiringIn = (seconds: number) => ({ expiresAt: NOW / 1000 + seconds });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the transport ceiling while the token outlives it", () => {
    // A freshly minted Railway token lives an hour, so the ceiling is what binds and the
    // common case is unchanged: a long build still gets its full fifteen minutes.
    expect(streamDurationMs(expiringIn(3600))).toBe(STREAM.MAX_DURATION_MS);
  });

  it("ends the stream with the token when the token expires first", () => {
    /*
     * The defect this function exists for. requireSession renews only inside the refresh
     * skew, so a session handed back one second above it opened a stream that ran the
     * full ceiling — ten of those minutes spent polling Railway with a credential it had
     * already stopped accepting, and a log pane that stopped for no stated reason.
     */
    expect(streamDurationMs(expiringIn(SESSION.REFRESH_SKEW_SECONDS + 1))).toBe(
      (SESSION.REFRESH_SKEW_SECONDS + 1) * 1000,
    );
    // The premise, asserted rather than assumed: were the skew ever raised past the
    // ceiling the clamp would go inert, and this line is what would say so.
    expect(SESSION.REFRESH_SKEW_SECONDS * 1000).toBeLessThan(STREAM.MAX_DURATION_MS);
  });

  it("takes the ceiling at the boundary rather than a second either side of it", () => {
    const seconds = STREAM.MAX_DURATION_MS / 1000;

    expect(streamDurationMs(expiringIn(seconds))).toBe(STREAM.MAX_DURATION_MS);
    expect(streamDurationMs(expiringIn(seconds + 1))).toBe(STREAM.MAX_DURATION_MS);
    expect(streamDurationMs(expiringIn(seconds - 1))).toBe(
      STREAM.MAX_DURATION_MS - 1000,
    );
  });
});
