import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, REGISTRY } from "@/lib/constants";
import { logRecords, rawLogLines } from "@/test/log-capture";
import type { ImageCheckStatus } from "@/lib/registry/reference";

const session = {
  user: { id: "u1", name: "Ada", email: "ada@example.com" },
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: 9_999_999_999,
  scope: "openid project:admin",
};
const requireSession = vi.fn(async () => session);
vi.mock("@/lib/auth/server", () => ({
  requireSession: () => requireSession(),
  requireAccessToken: async () => (await requireSession()).accessToken,
}));

/*
 * The probe is mocked rather than driven through MSW — probe.integration.test.ts already
 * owns every registry branch, and repeating them here would test that module twice and
 * this one not at all. What this file is about is the gate in front of it: what reaches
 * `checkImage`, what never does, and what the record says.
 */
const checkImage =
  vi.fn<
    (
      image: string,
      signal?: AbortSignal,
    ) => Promise<{ status: ImageCheckStatus; cached: boolean; registry: string }>
  >();
vi.mock("@/lib/registry/probe", () => ({
  checkImage: (image: string, signal?: AbortSignal) => checkImage(image, signal),
}));

const { GET } = await import("./route");

const request = (ref?: string) => {
  const url = new URL("/api/image-check", "http://localhost:3000");
  if (ref !== undefined) url.searchParams.set("ref", ref);
  return new NextRequest(url);
};

const answer = (status: ImageCheckStatus) => ({
  status,
  cached: false,
  registry: "docker.io",
});

beforeEach(() => {
  requireSession.mockReset().mockResolvedValue(session);
  checkImage.mockReset().mockResolvedValue(answer("available"));
});

describe("GET /api/image-check", () => {
  it.each<ImageCheckStatus>(["available", "unavailable", "unknown", "unsupported"])(
    "returns %s as it came back",
    async (status) => {
      checkImage.mockResolvedValue(answer(status));
      const response = await GET(request("redis:7-alpine"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status });
      // Never cached by a browser or a proxy: the cache that matters is the shared one on
      // this side, where it bounds egress rather than per-tab request count.
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );

  it("threads the inbound signal into the probe", async () => {
    // The whole architectural reason this is a route handler rather than a Server Action:
    // a check that fires as someone types must be cancellable by the next keystroke.
    await GET(request("owner/app"));
    expect(checkImage).toHaveBeenCalledWith("owner/app", expect.any(AbortSignal));
  });

  describe("refuses before doing anything expensive", () => {
    it.each([
      ["a missing reference", undefined],
      ["an empty reference", ""],
      ["a shell metacharacter", "redis; rm -rf /"],
      ["a space", "redis 7"],
      ["a leading separator", "/redis"],
      ["one over the ceiling", "a".repeat(LIMITS.IMAGE_REF_MAX + 1)],
    ])("400s on %s, without reading the session", async (_label, ref) => {
      const response = await GET(request(ref));

      expect(response.status).toBe(400);
      expect(checkImage).not.toHaveBeenCalled();
      // The syntax check is cheaper than a JWE decrypt, so it goes first — the same order
      // the watch route puts its id check in.
      expect(requireSession).not.toHaveBeenCalled();
    });

    it("401s without a session, and probes nothing", async () => {
      requireSession.mockRejectedValue(new Error("no session"));
      const response = await GET(request("owner/app"));

      expect(response.status).toBe(401);
      expect(checkImage).not.toHaveBeenCalled();
    });
  });

  describe("the concurrency slot", () => {
    it("refuses a user already at the cap, and frees the slot afterwards", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      checkImage.mockImplementation(async () => {
        await held;
        return answer("available");
      });

      const inFlight = Array.from({ length: REGISTRY.MAX_CONCURRENT_PER_USER }, () =>
        GET(request("owner/app")),
      );
      // Let each one get as far as the probe before the next request arrives.
      await Promise.resolve();

      const refused = await GET(request("owner/other"));
      expect(refused.status).toBe(429);

      release();
      await Promise.all(inFlight);

      // Released in a finally, so the cap is a ceiling on simultaneity rather than a
      // budget that runs out.
      checkImage.mockResolvedValue(answer("available"));
      expect((await GET(request("owner/app"))).status).toBe(200);
    });

    it("frees the slot even when the probe throws", async () => {
      checkImage.mockRejectedValue(new Error("boom"));
      await expect(GET(request("owner/app"))).rejects.toThrow();

      checkImage.mockResolvedValue(answer("available"));
      expect((await GET(request("owner/app"))).status).toBe(200);
    });
  });

  describe("the record", () => {
    it("names the registry and the outcome, and nothing the caller chose", async () => {
      checkImage.mockResolvedValue({
        status: "unavailable",
        cached: true,
        registry: "ghcr.io",
      });
      await GET(request("ghcr.io/owner/app:1.2.3"));

      const record = logRecords().find((entry) => entry.msg === "image.checked");
      expect(record).toMatchObject({
        registry: "ghcr.io",
        outcome: "unavailable",
        cached: true,
      });
      expect(record).toHaveProperty("duration_ms");
    });

    /*
     * The reference is unbounded, attacker-chosen, and arrives on every settled keystroke
     * of every signed-in visitor — the worst possible field to hand a log store. Same call
     * the stream route makes about a rejected deploymentId: the length carries the
     * diagnostic content and the value carries none.
     */
    it("never writes the reference itself, on any path", async () => {
      const secret = "verysecretimagenamexyz";
      await GET(request(`${secret}/app`));
      await GET(request(`${secret}; rm -rf /`));

      expect(rawLogLines().join("\n")).not.toContain(secret);
      expect(logRecords()).toContainEqual(
        expect.objectContaining({
          msg: "image.check_rejected",
          reason: "invalid_ref",
          ref_length: `${secret}; rm -rf /`.length,
        }),
      );
    });
  });
});
