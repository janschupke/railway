import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No route handler may build a browser-visible redirect from `request.url`.
 *
 * Behind Railway's proxy `request.url` is the *internal* origin — measured on the
 * deployed image as `http://localhost:<PORT>`, with the real `Host` and
 * `X-Forwarded-Host` headers not reaching it and the scheme taken from
 * `x-forwarded-proto`. A route handler's redirect is emitted as the absolute URL it was
 * given, so that origin arrives in the address bar: signing in against a grant with no
 * refresh token sent a real browser to `https://localhost:8080/api/auth/login?consent=1`.
 *
 * `APP_URL` is the app's declared origin and the only one it should ever name. It is
 * already what the OIDC `redirect_uri`, the cookie `secure` flag and the `__Host-` prefix
 * are derived from, so a redirect built from anything else can set a cookie scoped to one
 * origin and land the browser on another.
 *
 * Asserted structurally rather than per handler, in the idiom of
 * `lib/railway/mutation-callsites.test.ts`: the rule is about every file of a shape, and
 * the next route handler is the one that will forget it. `src/proxy.ts` is deliberately
 * out of scope — middleware emits a Location relative to the request it saw, which is
 * why its `new URL(…, request.url)` calls never reached a browser as an absolute URL.
 */
/** Plain recursion rather than fs.globSync, which is still experimental and warns. */
function routeHandlers(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeHandlers(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

const HANDLERS = routeHandlers("src/app");

/** `new URL(<anything>, request.url)` and the nextUrl spelling of the same mistake. */
const FROM_REQUEST_URL = /new URL\([^)]*?,\s*request\.(url|nextUrl)\s*\)/g;

describe("redirect origins", () => {
  it("finds the route handlers it is meant to be checking", () => {
    // A glob that silently matches nothing is a test that passes by knowing nothing.
    expect(HANDLERS.length).toBeGreaterThan(3);
  });

  it.each(HANDLERS)("%s builds redirects from APP_URL, not the request", (file) => {
    const source = readFileSync(file, "utf8");
    const offenders = [...source.matchAll(FROM_REQUEST_URL)].map((m) => m[0]);

    expect(
      offenders,
      `${file} builds a URL from request.url. Behind a proxy that is the container's ` +
        `own origin, and a route handler's redirect carries it to the browser. Use ` +
        `env().APP_URL as the base.`,
    ).toEqual([]);
  });
});
