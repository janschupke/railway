import { describe, expect, it } from "vitest";
import {
  UnknownOriginError,
  callbackUrl,
  originFromUrl,
  requireOrigin,
  resolveOrigin,
  type OriginConfig,
} from "./origin";

/**
 * The whole trust surface of the change that made the origin follow the request, exercised
 * where it is cheapest: no environment, no Next, no server. Every case here is either a
 * host somebody could send this app or a deployment somebody could configure.
 */
const FALLBACK: OriginConfig = { APP_URL: "http://localhost:3000", APP_ORIGINS: [] };
const NO_FALLBACK: OriginConfig = { APP_ORIGINS: [] };

/** A stand-in for the two header bags that reach this: Headers and ReadonlyHeaders. */
function headers(values: Record<string, string>) {
  return {
    get: (name: string) => values[name.toLowerCase()] ?? null,
  };
}

const origin = (values: Record<string, string>, config = FALLBACK) =>
  resolveOrigin(headers(values), config);

describe("resolveOrigin", () => {
  it("serves the host the request named", () => {
    expect(origin({ host: "trains.schupke.io" }).origin).toBe(
      "https://trains.schupke.io",
    );
  });

  it("prefers x-forwarded-host, which is the one a rewriting proxy leaves intact", () => {
    const result = origin({
      host: "internal.railway.internal",
      "x-forwarded-host": "trains.schupke.io",
    });

    expect(result.origin).toBe("https://trains.schupke.io");
  });

  it("takes the first entry when a chain of proxies has appended", () => {
    expect(
      origin({
        "x-forwarded-host": "trains.schupke.io, inner.example",
        "x-forwarded-proto": "https, http",
      }).origin,
    ).toBe("https://trains.schupke.io");
  });

  it("assumes https for a public host that arrived without a scheme header", () => {
    // The fail-safe direction: https is the value that keeps Secure and the __Host- prefix
    // on the session cookie, so a missing header cannot quietly downgrade it.
    expect(origin({ host: "trains.schupke.io" }).origin).toBe(
      "https://trains.schupke.io",
    );
  });

  it("assumes http for loopback, which is how dev and the e2e suite run", () => {
    expect(origin({ host: "localhost:3000" }).origin).toBe("http://localhost:3000");
    expect(origin({ host: "127.0.0.1:3100" }).origin).toBe("http://127.0.0.1:3100");
  });

  it("refuses a cleartext scheme on a public host rather than honouring it", () => {
    /*
     * The downgrade this exists to stop. Honouring the header means one hop — or one
     * caller who can reach the container directly — strips Secure off the session cookie
     * and drops the __Host- prefix, and the app would carry on serving as if nothing
     * happened.
     */
    const result = origin({
      "x-forwarded-host": "trains.schupke.io",
      "x-forwarded-proto": "http",
    });

    expect(result.refused).toBe("insecure");
    expect(result.origin).toBe("http://localhost:3000");
  });

  it.each([
    ["a path", "evil.example/api/auth/callback"],
    ["credentials", "user@evil.example"],
    ["whitespace", "trains.schupke.io evil.example"],
    ["a second scheme", "https://evil.example"],
  ])("refuses a host carrying %s", (_label, host) => {
    // Interpolating a header into a URL string parses far more than a host. The round trip
    // in resolveOrigin is what rejects anything that did not come back as it went in.
    const result = origin({ host });

    expect(result.refused).toBe("unparseable");
    expect(result.origin).toBe("http://localhost:3000");
  });

  it("falls back when the request named no host at all", () => {
    const result = origin({});

    expect(result.refused).toBe("absent");
    expect(result.origin).toBe("http://localhost:3000");
  });

  it("resolves nothing when there is no host and no fallback declared", () => {
    // A deployment with no APP_URL and no RAILWAY_PUBLIC_DOMAIN, which is now a supported
    // configuration rather than a boot failure. Every real browser sends Host.
    expect(origin({}, NO_FALLBACK).origin).toBeNull();
  });

  it("serves any host when no allowlist is configured", () => {
    expect(origin({ host: "anything.example" }).origin).toBe(
      "https://anything.example",
    );
  });

  it("serves a host the allowlist names", () => {
    const config: OriginConfig = {
      APP_ORIGINS: ["https://trains.schupke.io", "https://console.up.railway.app"],
    };

    expect(origin({ host: "console.up.railway.app" }, config).origin).toBe(
      "https://console.up.railway.app",
    );
  });

  it("refuses a host the allowlist does not name, and says which rule bit", () => {
    const config = {
      APP_URL: "https://trains.schupke.io",
      APP_ORIGINS: ["https://trains.schupke.io"],
    };
    const result = origin({ host: "console.up.railway.app" }, config);

    expect(result.refused).toBe("not_allowlisted");
    // The fallback is the operator's own statement about their deployment, so it is not
    // filtered through the allowlist a second time.
    expect(result.origin).toBe("https://trains.schupke.io");
  });

  it("resolves nothing when the allowlist refuses and nothing declares a fallback", () => {
    const config: OriginConfig = { APP_ORIGINS: ["https://trains.schupke.io"] };
    expect(origin({ host: "evil.example" }, config).origin).toBeNull();
  });

  it("normalises the host it was given", () => {
    expect(origin({ host: "TRAINS.Schupke.IO" }).origin).toBe(
      "https://trains.schupke.io",
    );
    // The default port is dropped, so a listed origin cannot miss on a spelling.
    expect(origin({ host: "trains.schupke.io:443" }).origin).toBe(
      "https://trains.schupke.io",
    );
  });
});

describe("originFromUrl", () => {
  it("reduces a configured URL to its origin", () => {
    expect(originFromUrl("https://trains.schupke.io/dashboard?x=1")).toBe(
      "https://trains.schupke.io",
    );
  });

  it.each(["http://trains.schupke.io", "ws://localhost:4010", "not-a-url", undefined])(
    "refuses %s",
    (value) => {
      expect(originFromUrl(value)).toBeNull();
    },
  );
});

describe("requireOrigin", () => {
  it("hands back the origin when there is one", () => {
    expect(requireOrigin(headers({ host: "trains.schupke.io" }), FALLBACK)).toBe(
      "https://trains.schupke.io",
    );
  });

  it("throws when there is not, naming the rule that refused", () => {
    // The Server Component path has no Response to return. It is an invariant rather than
    // a branch: the proxy has already answered 400 for anything that gets here.
    expect(() => requireOrigin(headers({}), NO_FALLBACK)).toThrow(UnknownOriginError);
    expect(() => requireOrigin(headers({}), NO_FALLBACK)).toThrow(/absent/);
  });
});

describe("callbackUrl", () => {
  it("builds the redirect URI that must match the OAuth app registration", () => {
    const resolved = requireOrigin(headers({ host: "trains.schupke.io" }), FALLBACK);
    expect(callbackUrl(resolved)).toBe("https://trains.schupke.io/api/auth/callback");
  });

  it("follows the request to a second domain", () => {
    const resolved = requireOrigin(
      headers({ host: "console.up.railway.app" }),
      FALLBACK,
    );
    expect(callbackUrl(resolved)).toBe(
      "https://console.up.railway.app/api/auth/callback",
    );
  });
});
