import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetEnv } from "@/env";
import { REGISTRY_DEFAULTS, registryFor } from "./registries";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.RAILWAY_CLIENT_ID = "id";
  process.env.RAILWAY_CLIENT_SECRET = "secret";
  process.env.SESSION_SECRET = "a-session-secret-of-at-least-32-chars";
  process.env.APP_URL = "http://localhost:3000";
  delete process.env.REGISTRY_PROBE_URL;
  __resetEnv();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  __resetEnv();
});

describe("the registry allowlist", () => {
  it.each(Object.values(REGISTRY_DEFAULTS))(
    "reaches $id over https and nothing else",
    (registry) => {
      // Not a style rule. TLS is what actually stops a hijacked A record for one of these
      // names from being answered by something else — a metadata service holds no
      // CA-issued certificate for ghcr.io and cannot complete the handshake.
      expect(registry.manifestBase.startsWith("https://")).toBe(true);
      expect(registry.tokenUrl.startsWith("https://")).toBe(true);
    },
  );

  it.each(["docker.io", "ghcr.io", "quay.io"])("has an entry for %s", (host) => {
    expect(registryFor(host)).not.toBeNull();
  });

  /*
   * The refusal, and it is the whole SSRF control. `parseImageReference` reports these as
   * registry hosts faithfully — Docker's rules say they are — and this is what declines to
   * turn any of them into a URL. Nothing downstream inspects an address, because nothing
   * downstream is ever handed one.
   */
  it.each([
    ["cloud metadata", "169.254.169.254"],
    ["loopback", "localhost"],
    ["loopback with a port", "localhost:5000"],
    ["a private address", "10.0.0.1"],
    ["an unlisted registry", "registry.example.com"],
    ["a lookalike", "ghcr.io.evil.example"],
    ["a prototype key", "constructor"],
    ["nothing at all", ""],
  ])("refuses %s", (_label, host) => {
    expect(registryFor(host)).toBeNull();
  });

  it("relocates all three when the E2E override is set", () => {
    process.env.REGISTRY_PROBE_URL = "http://localhost:4010";
    __resetEnv();

    for (const id of ["docker.io", "ghcr.io", "quay.io"] as const) {
      expect(registryFor(id)).toMatchObject({
        id,
        manifestBase: "http://localhost:4010",
        tokenUrl: "http://localhost:4010/token",
      });
    }
  });

  it("cannot be made to add a fourth registry by the override", () => {
    process.env.REGISTRY_PROBE_URL = "http://localhost:4010";
    __resetEnv();
    expect(registryFor("169.254.169.254")).toBeNull();
    expect(registryFor("registry.example.com")).toBeNull();
  });

  it("does not leave a double slash when the override carries a trailing one", () => {
    process.env.REGISTRY_PROBE_URL = "http://localhost:4010/";
    __resetEnv();
    expect(registryFor("ghcr.io")?.tokenUrl).toBe("http://localhost:4010/token");
  });
});
