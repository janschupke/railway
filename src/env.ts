import { z } from "zod";

/**
 * Railway injects RAILWAY_PUBLIC_DOMAIN into every deployment, so the app can
 * derive its own origin in production and only needs APP_URL set locally.
 */
function inferredAppUrl(): string | undefined {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return undefined;
}

/** Loopback is the only origin allowed to serve this app over plain http. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isSecureOrLocal(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The same rule as isSecureOrLocal, for the WebSocket scheme.
 *
 * `z.url()` accepts `ws://` — it parses, so it is a URL — which is why this cannot be
 * left to the type alone. The subscription sends the Railway access token on the upgrade
 * request, so a `ws://` host that is not loopback puts a live credential on the wire in
 * clear text, with the operator's only warning being that they typed it.
 */
function isWebSocketSecureOrLocal(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" || LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export const RAILWAY_DEFAULTS = {
  ISSUER: "https://backboard.railway.com",
  API_URL: "https://backboard.railway.com/graphql/v2",
  WS_URL: "wss://backboard.railway.com/graphql/v2",
} as const;

/**
 * Exported for src/env.test.ts, which asserts .env.example declares every field.
 *
 * architecture.md says a new variable means a schema field AND an entry in the example
 * file; nothing checked the second half, so the two could drift and the only symptom
 * would be an operator missing a variable they were never told about.
 */
export const schema = z.object({
  RAILWAY_CLIENT_ID: z.string().min(1, "RAILWAY_CLIENT_ID is required"),
  RAILWAY_CLIENT_SECRET: z.string().min(1, "RAILWAY_CLIENT_SECRET is required"),
  /** Any high-entropy string; the AES key is derived from it via HKDF. */
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 chars"),
  /**
   * https, unless it is loopback.
   *
   * Every cookie decision reads this string: `secure` is derived from it, and so is
   * whether the session cookie carries the `__Host-` prefix. So an APP_URL that says
   * http silently downgrades the session to a cleartext, unprefixed cookie — one
   * variable away from shipping Railway tokens in the clear, with nothing to warn you.
   *
   * Gated on the host rather than NODE_ENV on purpose: Playwright and serve-e2e both
   * run NODE_ENV=production against http://localhost:3100.
   */
  /*
   * The message names RAILWAY_PUBLIC_DOMAIN because APP_URL is the one field nobody sets
   * directly in production — inferredAppUrl derives it — so "APP_URL must be an absolute
   * URL" sent an operator looking for a variable they were right not to have set. Railway
   * injects RAILWAY_PUBLIC_DOMAIN only once the service has a public domain, which a new
   * service does not until someone generates one, and until then this is the whole reason
   * a correctly-built deployment fails its healthcheck.
   */
  APP_URL: z
    .url(
      "APP_URL is not set and could not be derived. On Railway it comes from " +
        "RAILWAY_PUBLIC_DOMAIN, which is injected only once the service has a public " +
        "domain: generate one under Settings > Networking, or set APP_URL explicitly " +
        "to the origin this app is reached at.",
    )
    .refine(isSecureOrLocal, "APP_URL must use https unless it points at localhost"),
  /**
   * Services this app creates are named `<prefix><name>`. The prefix is the
   * ownership marker that gates destructive actions — see lib/railway/managed.ts.
   */
  MANAGED_PREFIX: z.string().min(1).default("spun-"),
  /**
   * How often the project watcher asks Railway whether anything changed, in ms.
   *
   * Configurable because the right answer depends on the plan behind the token: the
   * default of 15s is 240 requests/hour against Hobby's 1000, and an account with more
   * headroom can reasonably go faster. Bounded below at one second so a typo cannot turn
   * a watcher into a denial of service against the user's own quota.
   *
   * The end-to-end suite sets it low so a spec can observe a change without waiting out
   * a production interval.
   */
  WATCH_POLL_MS: z.coerce.number().int().min(1_000).default(15_000),

  /*
   * Railway endpoints are configurable so the end-to-end suite can point the whole
   * app at a local fixture that speaks OIDC, GraphQL and graphql-ws. Nothing overrides
   * these in production. See e2e/fixtures/fake-railway/.
   */
  RAILWAY_ISSUER: z.url().default(RAILWAY_DEFAULTS.ISSUER),
  RAILWAY_API_URL: z.url().default(RAILWAY_DEFAULTS.API_URL),
  RAILWAY_WS_URL: z
    .url("RAILWAY_WS_URL must be an absolute URL")
    .refine(
      isWebSocketSecureOrLocal,
      "RAILWAY_WS_URL must use wss unless it points at localhost",
    )
    .default(RAILWAY_DEFAULTS.WS_URL),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse({
    /*
     * Read from the schema's own keys rather than a hand-written literal.
     *
     * WATCH_POLL_MS was declared above and left out of the literal below for its entire
     * life, and because it carries a default nothing ever failed: env() returned 15000
     * while playwright.config.ts, scripts/serve-e2e.ts and any deployment that set it
     * were all silently ignored. The variable that exists precisely so an operator can
     * tune it to their plan's rate limit was the one that could not be tuned.
     *
     * A list that has to be kept in step with the schema is a list that drifts. This one
     * cannot: every field is read from the environment variable of its own name, by
     * construction, and a field added above needs nothing here.
     */
    ...Object.fromEntries(
      Object.keys(schema.shape).map((key) => [key, process.env[key]]),
    ),
    // The one field not read from a variable of its own name: in production the origin
    // comes from Railway's injected RAILWAY_PUBLIC_DOMAIN instead. See inferredAppUrl.
    APP_URL: inferredAppUrl(),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Absolute callback URL. Must exactly match a redirect URI registered on the Railway OAuth app. */
export function callbackUrl(): string {
  return new URL("/api/auth/callback", env().APP_URL).toString();
}

/** Reset the memoised env. Tests only. */
export function __resetEnv() {
  cached = undefined;
}
