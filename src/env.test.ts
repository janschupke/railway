import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RAILWAY_DEFAULTS, __resetEnv, callbackUrl, env, schema } from "./env";

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
    // Was set but never asserted, so nothing here held the override actually applied.
    expect(env().RAILWAY_API_URL).toBe("http://localhost:4010/graphql/v2");
    expect(env().RAILWAY_WS_URL).toBe("ws://localhost:4010/graphql/v2");
  });

  it("refuses a cleartext WebSocket endpoint that is not loopback", () => {
    /*
     * The subscription sends the Railway access token on the upgrade request, so a
     * `ws://` host that is not loopback puts a live credential on the wire in clear
     * text. This field was `z.string().min(1)` while both its siblings were `z.url()` —
     * and `z.url()` alone would not have caught it either, since `ws://` parses.
     */
    setEnv({ ...REQUIRED, RAILWAY_WS_URL: "ws://backboard.railway.com/graphql/v2" });
    expect(() => env()).toThrow(/RAILWAY_WS_URL/);

    setEnv({ ...REQUIRED, RAILWAY_WS_URL: "not-a-url" });
    expect(() => env()).toThrow(/RAILWAY_WS_URL/);
  });

  it("allows wss anywhere, and ws only on loopback", () => {
    setEnv({ ...REQUIRED, RAILWAY_WS_URL: "wss://backboard.railway.com/graphql/v2" });
    expect(env().RAILWAY_WS_URL).toBe("wss://backboard.railway.com/graphql/v2");

    // The e2e fixture, which must keep working.
    setEnv({ ...REQUIRED, RAILWAY_WS_URL: "ws://127.0.0.1:4010/graphql/v2" });
    expect(env().RAILWAY_WS_URL).toBe("ws://127.0.0.1:4010/graphql/v2");
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

  it("lets a deployment change the ownership prefix", () => {
    setEnv({ ...REQUIRED, MANAGED_PREFIX: "rc-" });
    expect(env().MANAGED_PREFIX).toBe("rc-");
  });

  it("defaults the watch interval to a quarter of Hobby's hourly budget", () => {
    setEnv({ ...REQUIRED, WATCH_POLL_MS: undefined });
    expect(env().WATCH_POLL_MS).toBe(15_000);
  });

  it("lets the environment set the watch interval", () => {
    /*
     * This is the assertion the file was missing. WATCH_POLL_MS was declared in the
     * schema and left out of the parse input, and because it carries a default nothing
     * failed — env() returned 15000 while playwright.config.ts, scripts/serve-e2e.ts and
     * every deployment that set it were ignored. A default test alone cannot see that;
     * only reading a value back through the environment can.
     */
    setEnv({ ...REQUIRED, WATCH_POLL_MS: "1000" });
    expect(env().WATCH_POLL_MS).toBe(1_000);
  });

  it("floors the watch interval, so a typo cannot become a self-inflicted DoS", () => {
    setEnv({ ...REQUIRED, WATCH_POLL_MS: "999" });
    expect(() => env()).toThrow(/WATCH_POLL_MS/);
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

describe("configuration surface", () => {
  const example = readFileSync(
    path.resolve(import.meta.dirname, "..", ".env.example"),
    "utf8",
  );

  /** Declared names, whether live (`KEY=`) or commented out (`# KEY=`). */
  const declared = new Set(
    [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
  );

  it("documents every variable the schema reads", () => {
    /*
     * architecture.md: a new variable means a schema field AND an entry in
     * .env.example. Only the first half was mechanical, so the two could drift and the
     * symptom would be an operator never learning a variable existed.
     */
    for (const key of Object.keys(schema.shape)) {
      expect(declared, `${key} is missing from .env.example`).toContain(key);
    }
  });

  it("documents LOG_LEVEL, which deliberately bypasses the schema", () => {
    // Read straight from process.env so the logger works before env() can be called.
    expect(declared).toContain("LOG_LEVEL");
  });

  it("does not advertise variables nothing reads", () => {
    const known = new Set([...Object.keys(schema.shape), "LOG_LEVEL"]);
    for (const key of declared) {
      expect(known, `${key} is in .env.example but nothing reads it`).toContain(key);
    }
  });
});

describe("optional fields", () => {
  /**
   * Every field carrying a default, and the value this suite overrides it with.
   *
   * The table IS the assertion. architecture.md asks for an *override* case per optional
   * field, not merely a default case, because WATCH_POLL_MS shipped with a default that
   * worked and an override that was silently ignored for the field's entire life — the
   * one variable that existed to be tuned was the one that could not be.
   */
  const OVERRIDES: Record<string, { set: string; expect: string | number }> = {
    MANAGED_PREFIX: { set: "test-", expect: "test-" },
    WATCH_POLL_MS: { set: "2500", expect: 2500 },
    RAILWAY_ISSUER: { set: "http://localhost:4010", expect: "http://localhost:4010" },
    RAILWAY_API_URL: {
      set: "http://localhost:4010/graphql/v2",
      expect: "http://localhost:4010/graphql/v2",
    },
    RAILWAY_WS_URL: {
      set: "ws://localhost:4010/graphql/v2",
      expect: "ws://localhost:4010/graphql/v2",
    },
  };

  it("covers every field that has a default", () => {
    const defaulted = Object.entries(schema.shape)
      .filter(([, field]) => field.safeParse(undefined).success)
      .map(([key]) => key);

    // A new optional field fails here until it is given an override case below.
    expect(Object.keys(OVERRIDES).sort()).toEqual(defaulted.sort());
  });

  it.each(Object.entries(OVERRIDES))("honours an override of %s", (key, override) => {
    setEnv({ ...REQUIRED, [key]: override.set });
    expect(env()[key as keyof ReturnType<typeof env>]).toBe(override.expect);
  });
});
