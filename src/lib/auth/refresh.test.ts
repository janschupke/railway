import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RailwaySession } from "./session";

const refreshTokenGrant = vi.fn();

vi.mock("openid-client", () => ({
  refreshTokenGrant: (...args: unknown[]) => refreshTokenGrant(...args),
}));
vi.mock("./oidc", () => ({ oidcConfig: () => ({}) }));

const { refreshSession, SessionExpiredError } = await import("./refresh");

const base: RailwaySession = {
  user: { id: "user_1", name: "Ada" },
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: 1_000,
  scope: "openid project:admin",
};

describe("refreshSession", () => {
  // Braces matter: mockReset() returns the mock, and a beforeEach hook that returns a
  // function has that function invoked as teardown — which would call the mock again.
  beforeEach(() => {
    refreshTokenGrant.mockReset();
  });

  it("stores the rotated refresh token", async () => {
    refreshTokenGrant.mockResolvedValue({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      scope: "openid project:admin",
    });

    const next = await refreshSession(base, () => 10_000_000);

    // Railway rotates on every use — keeping the old token would strand the session.
    expect(next.refreshToken).toBe("new-refresh");
    expect(next.accessToken).toBe("new-access");
    expect(next.expiresAt).toBe(10_000 + 3600);
    expect(next.user).toEqual(base.user);
  });

  it("keeps the previous refresh token when the response omits one", async () => {
    refreshTokenGrant.mockResolvedValue({
      access_token: "new-access",
      expires_in: 3600,
    });

    const next = await refreshSession(base, () => 0);
    expect(next.refreshToken).toBe("old-refresh");
    expect(next.scope).toBe(base.scope);
  });

  it("defaults to a one-hour lifetime when expires_in is absent", async () => {
    refreshTokenGrant.mockResolvedValue({ access_token: "new-access" });
    const next = await refreshSession(base, () => 0);
    expect(next.expiresAt).toBe(3600);
  });

  it("raises SessionExpiredError when the grant fails", async () => {
    // Thrown lazily inside the call: mockRejectedValue would construct the rejected
    // promise before anything awaits it, which registers as an unhandled rejection.
    refreshTokenGrant.mockImplementation(async () => {
      throw new Error("invalid_grant");
    });
    await expect(refreshSession(base)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("raises SessionExpiredError when there is no refresh token", async () => {
    await expect(
      refreshSession({ ...base, refreshToken: undefined }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(refreshTokenGrant).not.toHaveBeenCalled();
  });

  it("spends a rotated token once, however many callers want it at the same moment", async () => {
    /*
     * The mechanism behind "it made me authorize again and again".
     *
     * Railway invalidates a refresh token the moment it is used. One dashboard load
     * puts many requests through the proxy holding the same cookie — the document, its
     * RSC payloads, and every open log stream — so without single-flight they each
     * opened their own grant with the same token: one won, the rest got invalid_grant,
     * and a session that had just been refreshed successfully was thrown away.
     */
    let resolveGrant: (value: unknown) => void = () => {};
    refreshTokenGrant.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGrant = resolve;
        }),
    );

    const callers = [
      refreshSession(base, () => 0),
      refreshSession(base, () => 0),
      refreshSession({ ...base, accessToken: "other" }, () => 0),
    ];
    resolveGrant({ access_token: "new-access", refresh_token: "new-refresh" });
    const results = await Promise.all(callers);

    expect(refreshTokenGrant).toHaveBeenCalledTimes(1);
    // Every caller leaves with the same live token, so whichever one writes the cookie
    // writes the same value.
    expect(results.map((r) => r.refreshToken)).toEqual([
      "new-refresh",
      "new-refresh",
      "new-refresh",
    ]);
  });

  it("does not cache a failure, so the next attempt is a real one", async () => {
    refreshTokenGrant.mockImplementation(async () => {
      throw new Error("invalid_grant");
    });
    await expect(refreshSession(base)).rejects.toBeInstanceOf(SessionExpiredError);

    refreshTokenGrant.mockResolvedValue({ access_token: "new-access" });
    await expect(refreshSession(base)).resolves.toMatchObject({
      accessToken: "new-access",
    });
  });

  it("keys the shared grant on the token, not on the user", async () => {
    // A caller holding a newer token must never be handed another token's result.
    refreshTokenGrant.mockImplementation(async (_config: unknown, token: string) => ({
      access_token: `access-for-${token}`,
    }));

    const [first, second] = await Promise.all([
      refreshSession(base, () => 0),
      refreshSession({ ...base, refreshToken: "newer-refresh" }, () => 0),
    ]);

    expect(refreshTokenGrant).toHaveBeenCalledTimes(2);
    expect(first.accessToken).toBe("access-for-old-refresh");
    expect(second.accessToken).toBe("access-for-newer-refresh");
  });
});
