import { env } from "@/env";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Railway's healthcheck target. Deliberately does not call the Railway API — a
 * healthcheck that depends on an upstream would cycle this deployment during an
 * unrelated Railway incident. It does touch env() so that a misconfigured deployment
 * fails the check rather than serving broken sign-in.
 *
 * "Misconfigured" is now a narrower claim than it was: a missing required secret, or an
 * optional value that is present and malformed. It no longer covers a service with no
 * public domain — the origin comes from the request, so such a service boots and serves,
 * and that condition was the most common false healthcheck failure this endpoint reported.
 *
 * It deliberately does not report the origin it resolved. This endpoint is unauthenticated,
 * and the resolved origin is derived from a header the caller wrote.
 */
export function GET() {
  try {
    env();
  } catch (error) {
    /*
     * The issue list names every variable that is missing or malformed. That is exactly
     * what an operator needs and exactly what an anonymous caller should not get — this
     * endpoint is unauthenticated, and it answers most usefully at the moment the
     * deployment is already broken. The detail goes to the log; the body says only that
     * the check failed.
     */
    log.error("health.env_invalid", {
      // Narrowed for the reason proxy.ts gives: a non-Error throw here logs `undefined`
      // and takes the issue list with it.
      issues: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ status: "misconfigured" }, { status: 503 });
  }
  return Response.json({ status: "ok" });
}
