import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RAILWAY_DEFAULTS, __resetEnv, callbackUrl, env } from "./env";

const ORIGINAL = { ...process.env };

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetEnv();
}

const REQUIRED = {
  RAILWAY_CLIENT_ID: "id",
  RAILWAY_CLIENT_SECRET: "secret",
  SESSION_SECRET: "a-session-secret-of-at-least-32-chars",
  APP_URL: "http://localhost:3000",
};

beforeEach(() => setEnv({ ...REQUIRED }));
afterEach(() => {
  process.env = { ...ORIGINAL };
  __resetEnv();
});

describe("env", () => {
  it("defaults the Railway endpoints to production", () => {
    const config = env();
    expect(config.RAILWAY_ISSUER).toBe(RAILWAY_DEFAULTS.ISSUER);
    expect(config.RAILWAY_API_URL).toBe(RAILWAY_DEFAULTS.API_URL);
    expect(config.RAILWAY_WS_URL).toBe(RAILWAY_DEFAULTS.WS_URL);
  });

  it("lets the E2E fixture take over the endpoints", () => {
    setEnv({
      ...REQUIRED,
      RAILWAY_ISSUER: "http://localhost:4010",
      RAILWAY_API_URL: "http://localhost:4010/graphql/v2",
      RAILWAY_WS_URL: "ws://localhost:4010/graphql/v2",
    });

    expect(env().RAILWAY_ISSUER).toBe("http://localhost:4010");
    expect(env().RAILWAY_WS_URL).toBe("ws://localhost:4010/graphql/v2");
  });

  it("derives APP_URL from Railway's injected domain in production", () => {
    // Only APP_URL is unset; the deployment supplies RAILWAY_PUBLIC_DOMAIN itself.
    setEnv({
      ...REQUIRED,
      APP_URL: undefined,
      RAILWAY_PUBLIC_DOMAIN: "console.up.railway.app",
    });

    expect(env().APP_URL).toBe("https://console.up.railway.app");
  });

  it("prefers an explicit APP_URL over the injected domain", () => {
    setEnv({ ...REQUIRED, RAILWAY_PUBLIC_DOMAIN: "console.up.railway.app" });
    expect(env().APP_URL).toBe("http://localhost:3000");
  });

  it("defaults the ownership prefix", () => {
    setEnv({ ...REQUIRED, MANAGED_PREFIX: undefined });
    expect(env().MANAGED_PREFIX).toBe("spun-");
  });

  it("names every missing variable at once rather than one per boot", () => {
    setEnv({
      RAILWAY_CLIENT_ID: undefined,
      RAILWAY_CLIENT_SECRET: undefined,
      SESSION_SECRET: undefined,
      APP_URL: undefined,
      RAILWAY_PUBLIC_DOMAIN: undefined,
    });

    expect(() => env()).toThrow(/RAILWAY_CLIENT_ID/);
    expect(() => env()).toThrow(/SESSION_SECRET/);
    expect(() => env()).toThrow(/APP_URL/);
  });

  it("rejects a session secret with too little entropy", () => {
    setEnv({ ...REQUIRED, SESSION_SECRET: "short" });
    expect(() => env()).toThrow(/at least 32/);
  });

  it("memoises, so a deployment cannot half-reconfigure at runtime", () => {
    const first = env();
    process.env.MANAGED_PREFIX = "changed-";
    expect(env()).toBe(first);
  });
});

describe("callbackUrl", () => {
  it("builds the redirect URI that must match the OAuth app registration", () => {
    expect(callbackUrl()).toBe("http://localhost:3000/api/auth/callback");
  });

  it("follows APP_URL to the deployed origin", () => {
    setEnv({ ...REQUIRED, APP_URL: "https://console.up.railway.app" });
    expect(callbackUrl()).toBe("https://console.up.railway.app/api/auth/callback");
  });
});

describe("APP_URL transport", () => {
  it("accepts an https origin", () => {
    setEnv({ ...REQUIRED, APP_URL: "https://console.up.railway.app" });
    expect(env().APP_URL).toBe("https://console.up.railway.app");
  });

  it("accepts http on loopback, which is how dev and the e2e fixture run", () => {
    setEnv({ ...REQUIRED, APP_URL: "http://localhost:3100" });
    expect(env().APP_URL).toBe("http://localhost:3100");
    setEnv({ ...REQUIRED, APP_URL: "http://127.0.0.1:3000" });
    expect(env().APP_URL).toBe("http://127.0.0.1:3000");
  });

  it("refuses http on a real host", () => {
    /*
     * This one variable decides `secure` on the session cookie and whether it carries
     * the __Host- prefix, so an http APP_URL in production silently ships Railway
     * tokens in the clear. Failing at boot is the only place that is cheap to notice.
     */
    setEnv({ ...REQUIRED, APP_URL: "http://console.up.railway.app" });
    expect(() => env()).toThrow(/https/i);
  });
});
