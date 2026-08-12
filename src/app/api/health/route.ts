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
    return Response.json(
      { status: "misconfigured", detail: (error as Error).message },
      { status: 503 },
    );
  }
  return Response.json({ status: "ok" });
}
