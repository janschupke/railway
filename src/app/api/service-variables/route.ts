import { type NextRequest } from "next/server";
import { requireSessionOrUnauthorized } from "@/lib/auth/route-guard";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { readServiceVariableNames } from "@/lib/railway/api";
import { RAILWAY_ID_PATTERN } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which variables a service has, by name. Never their values.
 *
 * The fifth route handler and the second that is not a stream, so the lane argument
 * `/api/image-check` makes applies here almost unchanged: this is a read a client component
 * performs mid-interaction, `dashboard/data.ts` is reserved for Server Components and
 * `dashboard/actions.ts` is the write lane, and a route handler is the only one of the three
 * with the inbound `AbortSignal` — which a dialog that can be closed before its request
 * lands genuinely wants.
 *
 * The reason it is not read on the list render instead is the one `managed.ts` states: this
 * costs a Railway round trip per service, against a rate limit that is the binding
 * constraint on this whole app, so twenty rows would be twenty requests for a panel nobody
 * has opened. It is read when someone opens the editor and not before.
 *
 * **This endpoint returns names and nothing else**, which is the property the edit form is
 * built on rather than a detail of its response shape: values are filtered out inside
 * `readServiceVariableNames`, on the server, so a generated database password has no path to
 * a browser through this route or any caller of it. See SECURITY.md, "Input surfaces".
 *
 * Ownership is deliberately not re-derived here, and that is the one place this route
 * differs from every mutation. The `MANAGED_PREFIX` check exists to stop this app changing
 * infrastructure it did not create (ADR-5); it is not an access-control layer, and it could
 * not be one — every request here carries the visitor's own Railway token, which already
 * reads these variables in Railway's own dashboard. Refusing an unmanaged service would cost
 * a second round trip to withhold something the caller can read anyway. The editor is only
 * offered on managed rows, so nothing asks.
 */
export async function GET(request: NextRequest) {
  return withRequestScope("/api/service-variables", { trustInboundId: true }, () =>
    handle(request),
  );
}

async function handle(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const projectId = params.get("project") ?? "";
  const environmentId = params.get("environment") ?? "";
  const serviceId = params.get("service") ?? "";

  /*
   * Cheapest refusal first, before the session read — the same order the watch and
   * image-check routes use. None of the three ids is logged at any level: they arrive on a
   * URL, unbounded and caller-chosen, which is the call the stream route already makes about
   * a rejected deploymentId.
   */
  if (
    !RAILWAY_ID_PATTERN.test(projectId) ||
    !RAILWAY_ID_PATTERN.test(environmentId) ||
    !RAILWAY_ID_PATTERN.test(serviceId)
  ) {
    log.warn("variables.read_rejected", { reason: "invalid_id" });
    return new Response("Bad Request", { status: 400 });
  }

  const session = await requireSessionOrUnauthorized("variables.read_rejected");
  if (session instanceof Response) return session;

  const names = await readServiceVariableNames(
    session.accessToken,
    { projectId, environmentId, serviceId },
    request.signal,
  );

  /*
   * A count, not the names. They are attacker-chosen and unbounded once a person can type
   * one — the same reason `container.updated` counts the user's half of the set instead of
   * naming it.
   */
  log.info("variables.read", { service_id: serviceId, variable_count: names.length });

  return Response.json({ names }, { headers: { "cache-control": "no-store" } });
}
