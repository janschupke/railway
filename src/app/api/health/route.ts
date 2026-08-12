import { env } from "@/env";

export const dynamic = "force-dynamic";

/**
 * Railway's healthcheck target. Deliberately does not call the Railway API — a
 * healthcheck that depends on an upstream would cycle this deployment during an
 * unrelated Railway incident. It does touch env() so that a misconfigured deployment
 * fails the check rather than serving broken sign-in.
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
    console.error(
      "health: invalid environment configuration\n",
      (error as Error).message,
    );
    return Response.json({ status: "misconfigured" }, { status: 503 });
  }
  return Response.json({ status: "ok" });
}
