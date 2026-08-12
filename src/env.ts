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

export const RAILWAY_DEFAULTS = {
  ISSUER: "https://backboard.railway.com",
  API_URL: "https://backboard.railway.com/graphql/v2",
  WS_URL: "wss://backboard.railway.com/graphql/v2",
} as const;

const schema = z.object({
  RAILWAY_CLIENT_ID: z.string().min(1, "RAILWAY_CLIENT_ID is required"),
  RAILWAY_CLIENT_SECRET: z.string().min(1, "RAILWAY_CLIENT_SECRET is required"),
  /** Any high-entropy string; the AES key is derived from it via HKDF. */
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 chars"),
  APP_URL: z.url("APP_URL must be an absolute URL"),
  /**
   * Services this app creates are named `<prefix><name>`. The prefix is the
   * ownership marker that gates destructive actions — see lib/railway/managed.ts.
   */
  MANAGED_PREFIX: z.string().min(1).default("spun-"),

  /*
   * Railway endpoints are configurable so the end-to-end suite can point the whole
   * app at a local fixture that speaks OIDC, GraphQL and graphql-ws. Nothing overrides
   * these in production. See e2e/fixtures/fake-railway/.
   */
  RAILWAY_ISSUER: z.url().default(RAILWAY_DEFAULTS.ISSUER),
  RAILWAY_API_URL: z.url().default(RAILWAY_DEFAULTS.API_URL),
  RAILWAY_WS_URL: z.string().min(1).default(RAILWAY_DEFAULTS.WS_URL),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse({
    RAILWAY_CLIENT_ID: process.env.RAILWAY_CLIENT_ID,
    RAILWAY_CLIENT_SECRET: process.env.RAILWAY_CLIENT_SECRET,
    SESSION_SECRET: process.env.SESSION_SECRET,
    APP_URL: inferredAppUrl(),
    MANAGED_PREFIX: process.env.MANAGED_PREFIX,
    RAILWAY_ISSUER: process.env.RAILWAY_ISSUER,
    RAILWAY_API_URL: process.env.RAILWAY_API_URL,
    RAILWAY_WS_URL: process.env.RAILWAY_WS_URL,
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
