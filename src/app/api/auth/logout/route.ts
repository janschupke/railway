import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { clearCookie, sessionCookieName } from "@/lib/auth/session";

/**
 * The four values Fetch Metadata defines for Sec-Fetch-Site.
 *
 * A browser only ever sends one of these, but the callers this handler rejects are by
 * definition not browsers, and curl will put whatever it likes in the header. Anything
 * off the list is recorded as `other`.
 */
const FETCH_SITES = new Set(["same-origin", "same-site", "cross-site", "none"]);

const fetchSite = (request: NextRequest): string => {
  const value = request.headers.get("sec-fetch-site");
  if (value === null) return "absent";
  return FETCH_SITES.has(value) ? value : "other";
};

/**
 * Route handlers get none of the origin checking Next applies to Server Actions, and
 * this one clears a cookie unconditionally — so a cross-site form POST signed the user
 * out. SameSite=Lax means the session cookie is not attached, which kept it to a
 * nuisance rather than a data exposure, but the handler should not be relying on the
 * cookie policy to decide whether to act.
 *
 * Sign-out is a native form POST (see sign-out-button.tsx), and the fetch spec requires
 * a form submission to send `Origin`, so checking it costs nothing legitimate.
 */
function sameOrigin(request: NextRequest): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;

  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return origin === new URL(env().APP_URL).origin;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  // The proxy matcher excludes api/auth, so an inbound x-request-id here is raw client
  // input and is not adopted.
  return withRequestScope("/api/auth/logout", { trustInboundId: false }, async () => {
    if (!sameOrigin(request)) {
      /*
       * A CSRF rejection, and until now a completely silent one.
       *
       * The Origin header itself is not recorded. It is attacker-chosen and unbounded —
       * anyone who can provoke this line picks the value that lands in the field an
       * operator greps — and the diagnostic content is only ever "was there an Origin at
       * all, and was it ours". Both of those survive as booleans. sec-fetch-site is kept
       * because the browser writes it from a closed set, not the caller.
       */
      log.warn("auth.logout.rejected", {
        reason: "cross_origin",
        origin_present: request.headers.get("origin") !== null,
        sec_fetch_site: fetchSite(request),
      });
      return new Response("Forbidden", { status: 403 });
    }

    /*
     * No subject id: this handler deliberately never opens the session, and paying an
     * HKDF derive plus an AES-GCM decrypt to decorate one log line is the wrong trade.
     */
    log.info("auth.session.cleared");

    /*
     * APP_URL, not request.url: in a route handler the latter is the container's own
     * origin, and the redirect goes out absolute. See the callback route.
     *
     * `?signed_out` is what the landing page keys its notice off. Sign-out here ends the
     * session on this app and nothing at Railway — the authorization survives, and
     * Railway offers no endpoint that would end it — so the page the user lands on is
     * the only place that difference can be stated at the moment it matters.
     */
    const response = NextResponse.redirect(new URL("/?signed_out=1", env().APP_URL), {
      // 303 so the browser follows with GET after the POST.
      status: 303,
    });
    clearCookie(response.cookies, sessionCookieName(env().APP_URL), env().APP_URL);
    return response;
  });
}
