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
});
