import { beforeEach, describe, expect, it, vi } from "vitest";

const headerStore = { value: null as Headers | null };
vi.mock("next/headers", () => ({
  headers: async () => {
    // Next throws here outside a request scope rather than returning empty, which is the
    // behaviour the fallback below exists for.
    if (!headerStore.value)
      throw new Error("`headers` was called outside a request scope");
    return headerStore.value;
  },
}));

const { withRequestScope } = await import("./request-scope");
const { requestContext } = await import("./context");

const ID = /^[0-9a-f]{16}$/;
const inbound = (value: string) => {
  headerStore.value = new Headers({ "x-request-id": value });
};

const idSeenBy = (route: string, trustInboundId: boolean) =>
  withRequestScope(route, { trustInboundId }, async () => requestContext()?.requestId);

beforeEach(() => {
  headerStore.value = null;
});

describe("withRequestScope", () => {
  it("adopts a well-formed id the proxy forwarded", async () => {
    // The proxy stamps this, and adopting it is what joins a proxy line to the render
    // lines that follow — the two are separate invocations with nothing else in common.
    inbound("a1b2c3d4e5f60718");
    await expect(idSeenBy("/dashboard", true)).resolves.toBe("a1b2c3d4e5f60718");
  });

  it("never adopts one on a path the proxy does not cover", async () => {
    /*
     * The matcher excludes api/auth, so what arrives at those handlers is raw client
     * input: attacker-chosen bytes in a field operators grep, an unbounded Loki label,
     * and a way to staple requests onto someone else's chain.
     */
    inbound("a1b2c3d4e5f60718");
    const id = await idSeenBy("/api/auth/callback", false);

    expect(id).not.toBe("a1b2c3d4e5f60718");
    expect(id).toMatch(ID);
  });

  it("mints a fresh id rather than trusting a malformed header", async () => {
    inbound("<script>alert(1)</script>");
    await expect(idSeenBy("/dashboard", true)).resolves.toMatch(ID);
  });

  it("survives being called with no request scope at all", async () => {
    /*
     * `headers()` throws here. Instrumentation that can fail the handler it observes is
     * worse than none, so this degrades to a fresh id — the same rule that makes an
     * unrecognised LOG_LEVEL clamp instead of throwing.
     */
    await expect(idSeenBy("/dashboard", true)).resolves.toMatch(ID);
  });

  it("carries the route, and returns whatever the body returned", async () => {
    inbound("a1b2c3d4e5f60718");
    const result = await withRequestScope(
      "/dashboard",
      { trustInboundId: true },
      async () => {
        expect(requestContext()?.route).toBe("/dashboard");
        return "value";
      },
    );

    expect(result).toBe("value");
  });
});
