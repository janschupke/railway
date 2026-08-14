/**
 * The origin this app is being reached at, derived from the request that arrived.
 *
 * It used to be a variable. `APP_URL`, or `https://${RAILWAY_PUBLIC_DOMAIN}` when that was
 * unset, was the single origin the app named in its OIDC `redirect_uri`, in every redirect
 * a browser follows, in the cookie `secure` flag and `__Host-` prefix, in logout's CSRF
 * check and in the CSP. One string, so exactly one domain could ever work — and on a
 * service with a custom domain the injected variable names the *generated*
 * `*.up.railway.app` one, so sign-in walked the user off the domain they had typed.
 *
 * `request.url` is not the answer and never was: Next's standalone `server.js` builds it
 * from its own bind address, so behind Railway's proxy it reads `http://localhost:8080`.
 * That was measured — see src/app/redirect-origin.test.ts, which still bans it. The
 * headers are intact; only the URL Next assembled from them is not. So this module reads
 * the headers.
 *
 * Deliberately dependency-free. src/proxy.ts imports it, so it can carry neither
 * `server-only` nor `next/headers`; src/env.ts imports isSecureOrLocal back out of it, so
 * it must not import `@/env`. Configuration arrives as a parameter, which keeps that
 * dependency one-directional and lets the whole module be tested with no environment.
 */

declare const ORIGIN_BRAND: unique symbol;

/**
 * A scheme-and-host string that has passed isSecureOrLocal. Only this module mints one.
 *
 * The brand exists because the value now comes from a header. `cookieOptions(appUrl:
 * string)` accepted `request.headers.get("x-forwarded-host")!` without complaint, returned
 * `secure: false` for it and dropped the `__Host-` prefix on the same test — a session
 * downgraded to a cleartext, unprefixed cookie, with no compile error and no failing test,
 * because dev and the e2e suite both run on http and would not have noticed. The brand is
 * the type-level statement of "this string was validated", checked by the compiler instead
 * of remembered by the next caller.
 */
export type AppOrigin = string & { readonly [ORIGIN_BRAND]: true };

/** Loopback is the only host allowed to serve this app over plain http. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** `URL.hostname` keeps the brackets on an IPv6 literal, which is why both spellings are listed. */
export function isLoopbackHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname);
}

/**
 * https, or plain http to loopback. The single transport rule for this app's own origin.
 *
 * Every cookie decision reads the result: `secure` is derived from it, and so is whether
 * the session cookie carries the `__Host-` prefix. An origin that says http is one
 * variable — or now one header — away from shipping Railway tokens in the clear.
 *
 * Gated on the host rather than NODE_ENV on purpose: Playwright and serve-e2e both run
 * NODE_ENV=production against http://localhost:3100.
 */
export function isSecureOrLocal(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** The one question the cookie layer asks of an origin, named once instead of spelled out. */
export function isSecureOrigin(origin: AppOrigin): boolean {
  return origin.startsWith("https://");
}

/**
 * An absolute URL reduced to its origin, or null.
 *
 * One of the two producers of AppOrigin, and the one that turns operator configuration
 * (`APP_URL`, `APP_ORIGINS`) into a value the cookie layer will accept. Normalising
 * through `URL.origin` is what stops a trailing slash, an explicit `:443` or a capitalised
 * host from making a correctly-configured domain fail to match.
 */
export function originFromUrl(value: string | undefined): AppOrigin | null {
  if (!value || !isSecureOrLocal(value)) return null;
  return new URL(value).origin as AppOrigin;
}

/** Satisfied by both `Headers` and next/headers' `ReadonlyHeaders`. */
type HeaderReader = { get(name: string): string | null };

/**
 * Structurally typed rather than `Pick<Env, …>`, so this module does not import `@/env`.
 * `env()` satisfies it by construction, and a test can pass a literal.
 */
export type OriginConfig = {
  /** Optional rather than `string | undefined`, so `env()` satisfies this as it stands. */
  readonly APP_URL?: string | undefined;
  readonly APP_ORIGINS: readonly string[];
};

/**
 * Why the request's own host was not used. Bounded on purpose: it is the only thing the
 * refusal path may log. The host itself is attacker-chosen and unbounded — the same rule
 * the rejected deploymentId and logout's `Origin` header already follow — so whoever
 * provokes the line would otherwise be choosing the value an operator greps.
 */
export type OriginRefusal = "absent" | "unparseable" | "insecure" | "not_allowlisted";

export type OriginResolution = {
  /** null only when the request named no usable origin and nothing declares a fallback. */
  readonly origin: AppOrigin | null;
  /** Absent when the request's own host was used. */
  readonly refused?: OriginRefusal;
};

/** The first entry of a header a chain of proxies appends to. */
function firstValue(raw: string | null): string | undefined {
  const first = raw?.split(",")[0]?.trim();
  return first ? first : undefined;
}

/**
 * `URL` drops a scheme's default port; a Host header is allowed to state it.
 *
 * Without this, `Host: trains.schupke.io:443` round-trips to `trains.schupke.io`, fails
 * the equality check below and falls back — which is the bug this whole module exists to
 * fix, reintroduced over a spelling.
 */
function withoutDefaultPort(host: string, scheme: string): string {
  if (scheme === "https" && host.endsWith(":443")) return host.slice(0, -4);
  if (scheme === "http" && host.endsWith(":80")) return host.slice(0, -3);
  return host;
}

function refuse(reason: OriginRefusal, config: OriginConfig): OriginResolution {
  return { origin: originFromUrl(config.APP_URL), refused: reason };
}

/**
 * The origin for one request.
 *
 * `x-forwarded-host` before `host`, because a proxy that rewrites the Host it forwards
 * puts the address the client actually used in the former. Both are client-writable to
 * anyone who can reach the container directly, which is what the rest of this function is
 * about.
 *
 * The trust decision, recorded once here: an unset APP_ORIGINS accepts any host the edge
 * reports. That is what makes a new custom domain need no configuration, and it holds
 * because nothing downstream of it is exploitable by naming a host you already control —
 * Railway's OAuth app enforces its registered redirect_uris, so a spoofed origin cannot
 * receive an authorization code; the cookies are `__Host-`, so a spoofed Host produces a
 * session only in the spoofer's own browser; there is no shared cache to poison; and there
 * is no email or magic-link layer that could carry a spoofed origin to someone else.
 * APP_ORIGINS exists for deployments that would rather not rely on that argument.
 */
export function resolveOrigin(
  headers: HeaderReader,
  config: OriginConfig,
): OriginResolution {
  const raw =
    firstValue(headers.get("x-forwarded-host")) ?? firstValue(headers.get("host"));
  if (!raw) return refuse("absent", config);
  const host = raw.toLowerCase();

  /*
   * Parsed before the scheme is chosen, because choosing it needs the hostname with the
   * port already separated off — `localhost:3000` is loopback and the string does not say
   * so. The scheme cannot change what parses here: both candidates are special schemes.
   */
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    return refuse("unparseable", config);
  }

  /*
   * The round trip is the validation. Interpolating a header into a URL string parses far
   * more than a host: `evil.example/path`, `user@evil.example` and a unicode host that
   * punycodes into something else all produce a URL, and all produce a different one than
   * the caller would read off the header. Requiring the parse to hand back exactly the
   * host it was given, with nothing else attached, rejects the lot.
   */
  if (
    parsed.host !== withoutDefaultPort(host, "https") ||
    parsed.pathname !== "/" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return refuse("unparseable", config);
  }

  /*
   * Scheme defaults to https for a public host, and http only for loopback.
   *
   * Fail-safe direction: https is the value that *keeps* Secure and the `__Host-` prefix
   * on the session cookie, so a missing x-forwarded-proto cannot quietly downgrade it.
   */
  const proto = firstValue(headers.get("x-forwarded-proto"))?.toLowerCase();
  const scheme = proto ?? (isLoopbackHost(parsed.hostname) ? "http" : "https");
  const candidate = `${scheme}://${withoutDefaultPort(parsed.host, scheme)}`;

  /*
   * An explicit `x-forwarded-proto: http` on a public host is refused rather than honoured.
   * Honouring it means one header strips Secure off the session cookie and drops the
   * `__Host-` prefix — the exact downgrade the transport rule exists to prevent. Anything
   * that is not http or https fails the same test.
   */
  if (!isSecureOrLocal(candidate)) return refuse("insecure", config);

  if (config.APP_ORIGINS.length > 0 && !config.APP_ORIGINS.includes(candidate)) {
    return refuse("not_allowlisted", config);
  }

  return { origin: candidate as AppOrigin };
}

export class UnknownOriginError extends Error {
  constructor(reason: OriginRefusal) {
    super(`the request named no usable origin (${reason})`);
    this.name = "UnknownOriginError";
  }
}

/**
 * The origin, or a throw.
 *
 * For the one caller with no Response to return — src/lib/auth/server.ts, running inside a
 * Server Component. Every path that reaches it is covered by the proxy matcher, and the
 * proxy has already answered 400 for an unresolvable origin, so this is an invariant
 * rather than a branch anyone reaches.
 */
export function requireOrigin(headers: HeaderReader, config: OriginConfig): AppOrigin {
  const { origin, refused } = resolveOrigin(headers, config);
  if (!origin) throw new UnknownOriginError(refused ?? "absent");
  return origin;
}

/**
 * Absolute callback URL for one origin.
 *
 * Must exactly match a redirect URI registered on the Railway OAuth app — which now means
 * one registered per domain the app is reached on, because this follows the request.
 */
export function callbackUrl(origin: AppOrigin): string {
  return new URL("/api/auth/callback", origin).toString();
}
