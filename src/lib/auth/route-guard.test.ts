import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();
vi.mock("./server", () => ({ requireSession: () => requireSession() }));

const debug = vi.fn();
vi.mock("@/lib/logger", () => ({
  log: { debug: (...args: unknown[]) => debug(...args) },
}));

const { requireSessionOrUnauthorized } = await import("./route-guard");

const SESSION = { user: { id: "user_1" }, accessToken: "tok" };

beforeEach(() => {
  requireSession.mockReset();
  debug.mockReset();
});

describe("requireSessionOrUnauthorized", () => {
  it("hands back the session when there is one", async () => {
    requireSession.mockResolvedValue(SESSION);
    await expect(requireSessionOrUnauthorized("stream.rejected")).resolves.toBe(
      SESSION,
    );
    expect(debug).not.toHaveBeenCalled();
  });

  it("answers 401 rather than throwing, so the route keeps its own control flow", async () => {
    requireSession.mockRejectedValue(new Error("no session"));

    const refusal = await requireSessionOrUnauthorized("stream.rejected");
    expect(refusal).toBeInstanceOf(Response);
    expect((refusal as Response).status).toBe(401);
  });

  it("records the refusal at debug, under the route's own event name", async () => {
    /*
     * The judgement this helper exists to hold, and the reason it is not `warn`: an
     * expired tab reopens its EventSource in a loop and the image check fires on every
     * settled keystroke, so at info this is the noisiest line in the system while saying
     * nothing an operator can act on. The event name is the caller's, so the reason joins
     * that route's own series rather than a name four routes share.
     */
    requireSession.mockRejectedValue(new Error("no session"));

    await requireSessionOrUnauthorized("image.check_rejected");

    expect(debug).toHaveBeenCalledExactlyOnceWith("image.check_rejected", {
      reason: "unauthenticated",
    });
  });

  it("writes nothing about why the session was refused", async () => {
    // The rejection can carry a token expiry or a decrypt failure; neither is a field an
    // operator's log store should hold. `reason` is a fixed string, not the error's.
    requireSession.mockRejectedValue(new Error("JWE decryption failed for tok_abc123"));

    await requireSessionOrUnauthorized("watch.rejected");

    expect(JSON.stringify(debug.mock.calls)).not.toContain("tok_abc123");
  });
});
