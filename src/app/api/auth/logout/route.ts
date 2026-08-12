import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
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
  if (!sameOrigin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const response = NextResponse.redirect(new URL("/", request.url), {
    // 303 so the browser follows with GET after the POST.
    status: 303,
  });
  response.cookies.delete(sessionCookieName(env().APP_URL));
  return response;
}
