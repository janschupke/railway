import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No route handler may name an origin of its own. Not `request.url`, and not `APP_URL`.
 *
 * `request.url` first, because it is measured: behind Railway's proxy it is the *internal*
 * origin, `http://localhost:<PORT>`. Next's standalone `server.js` builds that URL from
 * its own bind address rather than from the headers, which is why forwarding a real Host
 * and X-Forwarded-Host to the built image changed nothing about it. A route handler's
 * redirect is emitted as the absolute URL it was given, so that origin arrives in the
 * address bar: signing in against a grant with no refresh token sent a real browser to
 * `https://localhost:8080/api/auth/login?consent=1`.
 *
 * `APP_URL` is the newer half of the rule, and was for a while the fix for the first half.
 * It is now the *fallback* — the origin for a request that carried no usable Host — and
 * naming it in a handler is the second version of the same bug: a sign-in started on a
 * custom domain was conducted against whichever single origin that variable held, which on
 * Railway is the generated `*.up.railway.app` one. Both mistakes end the same way, with a
 * response that sets a cookie scoped to one origin and sends the browser to another.
 *
 * What a handler uses instead is `requestOrigin` from lib/auth/request-origin.ts: it
 * derives the origin from the request's own headers, validates it, and keeps the fallback
 * inside itself so no caller has to reach for it.
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

/**
 * `APP_URL` anywhere in a handler's code, not merely as a redirect base.
 *
 * The broader rule is also the simpler one: with the origin derived per request there is
 * no legitimate use for the variable in a route handler at all, so there is no line to
 * draw between a base and a comparison, and no way for a new call site to sit on the
 * wrong side of one.
 */
const NAMES_APP_URL = /\bAPP_URL\b/g;

/** Comments stripped, so prose in a handler describing the rule cannot trip it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("redirect origins", () => {
  it("finds the route handlers it is meant to be checking", () => {
    // A glob that silently matches nothing is a test that passes by knowing nothing.
    expect(HANDLERS.length).toBeGreaterThan(3);
  });

  it.each(HANDLERS)("%s builds redirects from the request, not its URL", (file) => {
    const code = withoutComments(readFileSync(file, "utf8"));
    const offenders = [...code.matchAll(FROM_REQUEST_URL)].map((m) => m[0]);

    expect(
      offenders,
      `${file} builds a URL from request.url. Behind a proxy that is the container's ` +
        `own origin, and a route handler's redirect carries it to the browser. Use ` +
        `requestOrigin(request) as the base.`,
    ).toEqual([]);
  });

  it.each(HANDLERS)("%s does not name the configured fallback origin", (file) => {
    const code = withoutComments(readFileSync(file, "utf8"));
    const offenders = [...code.matchAll(NAMES_APP_URL)].map((m) => m[0]);

    expect(
      offenders,
      `${file} names APP_URL. That is the fallback for a request with no usable Host, ` +
        `not the origin this request arrived at — using it answers one domain's request ` +
        `with another domain's address. Use requestOrigin(request).`,
    ).toEqual([]);
  });
});
