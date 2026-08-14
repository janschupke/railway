import { z } from "zod";
import { isLoopbackHost, isSecureOrLocal } from "@/lib/origin";

/**
 * The origin to use when a request did not carry a usable one.
 *
 * Not the app's origin — that comes from the request now, see src/lib/origin.ts. This is
 * the operator's explicit override and the floor under a caller that sent no Host at all.
 * Railway injects RAILWAY_PUBLIC_DOMAIN once a service has a public domain, which makes it
 * a serviceable fallback, but it names the *generated* domain even on a service that also
 * has a custom one — which is exactly why it is no longer what the app derives its origin
 * from.
 */
function fallbackOrigin(): string | undefined {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return undefined;
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
    return url.protocol === "wss:" || isLoopbackHost(url.hostname);
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
   * Optional. The app serves whatever domain the request arrived on — see lib/origin.ts.
   *
   * Set it only to override that, and it is what a request carrying no usable Host falls
   * back to. It used to be required, and the long error it carried named
   * RAILWAY_PUBLIC_DOMAIN and told the operator to generate a public domain, because a
   * service without one could not parse its environment and answered its healthcheck with
   * 503. That failure no longer exists — a service with no domain now boots and serves —
   * and the message is deleted rather than reworded, so nothing invites it back.
   *
   * Still https unless it is loopback, for the reason lib/origin.ts gives at
   * isSecureOrLocal: every cookie decision reads the origin, so an http one silently
   * downgrades the session to a cleartext, unprefixed cookie.
   */
  APP_URL: z
    .url("APP_URL must be an absolute URL, e.g. https://trains.schupke.io")
    .refine(isSecureOrLocal, "APP_URL must use https unless it points at localhost")
    .optional(),
  /**
   * Origins the app will answer as, comma-separated. Unset means any host the edge reports.
   *
   * The default is open because that is what makes a new custom domain need no
   * configuration at all: point it at the service, register its callback on the Railway
   * OAuth app, done. lib/origin.ts records why that is defensible — a spoofed host cannot
   * receive an authorization code, cannot plant a cookie anywhere but the spoofer's own
   * browser, and has no cache or mail path to ride out of.
   *
   * Setting it does NOT implicitly allow APP_URL or RAILWAY_PUBLIC_DOMAIN. An allowlist
   * with a hidden extra entry is not an allowlist; list the generated `*.up.railway.app`
   * domain too if you want it to keep working.
   *
   * Entries are normalised through URL.origin so a trailing slash, an explicit `:443` or a
   * capitalised host cannot make a correctly-configured domain miss.
   */
  APP_ORIGINS: z
    .string()
    .default("")
    .transform((raw) =>
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .refine(
      (origins) => origins.every(isSecureOrLocal),
      "APP_ORIGINS entries must be absolute origins, https unless they point at localhost",
    )
    .transform((origins) => origins.map((origin) => new URL(origin).origin)),
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
  /**
   * How stale an on-screen usage readout may get before the watcher nudges the tab, in ms.
   *
   * The one number that decides what the metrics feature costs. Metrics are read on the
   * render, not polled, so nothing refreshes them while a project sits unchanged — this is
   * how often the watcher sends a second one-bit event asking the tab to re-render anyway.
   *
   * The arithmetic, in ADR-10's terms. At 120s a visible dashboard forces at most 30 renders
   * an hour; a render is four Railway requests now rather than three, so 120/hour on top of
   * the watcher's own 240, against Hobby's documented 1000. Halving this doubles that half.
   * Only visible tabs count — the client closes the connection when the tab is hidden — and
   * only environments with something running, because a nudge for an idle project would
   * refresh a page whose numbers cannot have moved.
   *
   * `0` disables metrics outright: no nudge, no metrics request, no readout. That is the
   * setting for an account whose quota is already committed to log streams, and it is
   * expressed here rather than in a second METRICS_ENABLED flag so there is no state where
   * one variable says on and the other says never.
   *
   * Any other value is floored at one second, matching WATCH_POLL_MS rather than being set
   * higher on the theory that this knob is more expensive. The floor is a sanity bound, not
   * the quota protection — a one-second watcher is already 3,600 requests an hour against
   * Hobby's 1,000, so neither floor is what keeps an operator honest. What it buys is the
   * same thing it buys there: the end-to-end suite can drive a staleness window without
   * waiting out a production one.
   */
  METRICS_POLL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .refine(
      (value) => value === 0 || value >= 1_000,
      "METRICS_POLL_MS must be 0 (disabled) or at least 1000",
    )
    .default(120_000),

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

  /**
   * Where the registry existence check sends its requests, for the same reason the three
   * above exist: the end-to-end suite must not reach a real registry. When set, every
   * entry in the allowlist points here — see `registryFor` in lib/registry/registries.ts.
   *
   * Two things make this a smaller surface than RAILWAY_WS_URL, which is the precedent it
   * follows. The requests it redirects carry **no credential of any kind** — no bearer, no
   * cookie, no body — where a `ws://` Railway endpoint would put a live access token on
   * the wire in clear text. And it does not widen the allowlist: the registry is still
   * resolved from the reference against the same three hardcoded ids, and anything else is
   * still refused without a request. A misconfigured value is an app that says nothing
   * about images, which is what it says on every other failure too.
   *
   * No default, because there is no fallback to fall back to: unset means the real
   * registries, which is what the constant table already holds.
   */
  REGISTRY_PROBE_URL: z
    .url("REGISTRY_PROBE_URL must be an absolute URL")
    .refine(
      isSecureOrLocal,
      "REGISTRY_PROBE_URL must use https unless it points at localhost",
    )
    .optional(),
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
    // The one field not read from a variable of its own name: with APP_URL unset the
    // fallback comes from Railway's injected RAILWAY_PUBLIC_DOMAIN. See fallbackOrigin.
    APP_URL: fallbackOrigin(),
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

/** Reset the memoised env. Tests only. */
export function __resetEnv() {
  cached = undefined;
}
