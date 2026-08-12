import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { sessionCookieName } from "@/lib/auth/session";

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
      // A CSRF rejection, and until now a completely silent one.
      log.warn("auth.logout.rejected", {
        reason: "cross_origin",
        origin: request.headers.get("origin"),
        sec_fetch_site: request.headers.get("sec-fetch-site"),
      });
      return new Response("Forbidden", { status: 403 });
    }

    /*
     * No subject id: this handler deliberately never opens the session, and paying an
     * HKDF derive plus an AES-GCM decrypt to decorate one log line is the wrong trade.
     */
    log.info("auth.session.cleared");

    const response = NextResponse.redirect(new URL("/", request.url), {
      // 303 so the browser follows with GET after the POST.
      status: 303,
    });
    response.cookies.delete(sessionCookieName(env().APP_URL));
    return response;
  });
}
