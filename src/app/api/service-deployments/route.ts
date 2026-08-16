import { type NextRequest } from "next/server";
import { requireSessionOrUnauthorized } from "@/lib/auth/route-guard";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { listServiceDeployments } from "@/lib/railway/service-lifecycle";
import { applyStoppedToHistory } from "@/lib/railway/stopped";
import { RAILWAY_ID_PATTERN } from "@/lib/validation/patterns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One service's earlier deployments, for the rollback control in an expanded row.
 *
 * The sixth route handler and the third that is not a stream, and it is here for the reason
 * `/api/service-variables` states next door: this is a read a client component performs
 * mid-interaction, `dashboard/data.ts` is reserved for Server Components, `dashboard/actions.ts`
 * is the write lane, and a route handler is the only one of the three that gets the inbound
 * `AbortSignal` — which a panel that can be collapsed before its request lands genuinely
 * wants.
 *
 * Not read on the list render for the same reason the variables are not: it costs a Railway
 * round trip per service, against the rate limit that is the binding constraint on this whole
 * app, so twenty rows would be twenty requests for a panel nobody has opened. It is read when
 * someone expands a managed row and not before.
 *
 * **This endpoint decides nothing.** It answers with a list, and the rollback that follows is
 * a Server Action which re-reads the same list behind the ownership guard before sending
 * anything — so an answer from here is a menu, never a permission. Ownership is deliberately
 * not re-derived, exactly as it is not in `/api/service-variables`: the `MANAGED_PREFIX` check
 * exists to stop this app changing infrastructure it did not create (ADR-5), it is not an
 * access-control layer and could not be one, since every request here carries the visitor's own
 * Railway token, which already reads these deployments in Railway's own dashboard. Refusing an
 * unmanaged service would cost a second round trip to withhold something the caller can read
 * anyway; the panel only offers this on managed rows, so nothing asks.
 */
export async function GET(request: NextRequest) {
  return withRequestScope("/api/service-deployments", { trustInboundId: true }, () =>
    handle(request),
  );
}

async function handle(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const projectId = params.get("project") ?? "";
  const environmentId = params.get("environment") ?? "";
  const serviceId = params.get("service") ?? "";

  /*
   * Cheapest refusal first, before the session read — the same order the variables, watch and
   * image-check routes use. None of the three ids is logged at any level: they arrive on a
   * URL, unbounded and caller-chosen, which is the call the stream route already makes about a
   * rejected deploymentId.
   */
  if (
    !RAILWAY_ID_PATTERN.test(projectId) ||
    !RAILWAY_ID_PATTERN.test(environmentId) ||
    !RAILWAY_ID_PATTERN.test(serviceId)
  ) {
    log.warn("deployments.read_rejected", { reason: "invalid_id" });
    return new Response("Bad Request", { status: 400 });
  }

  const session = await requireSessionOrUnauthorized("deployments.read_rejected");
  if (session instanceof Response) return session;

  /*
   * Degrading: `Deployments` is in DEGRADING_OPERATIONS, so a refusal comes back as no
   * entries rather than throwing — and `refused` is what tells the two empty cases apart.
   * The panel has a different sentence for each, and without this flag it told anyone whose
   * token cannot make the read that their service had never deployed.
   *
   * A flag rather than a status code, because the request itself succeeded: this endpoint
   * answers what the app was able to learn, and "nothing, because Railway said no" is an
   * answer rather than a failure of the route.
   */
  const { entries, refused } = await listServiceDeployments(
    session.accessToken,
    { projectId, environmentId, serviceId },
    request.signal,
  );

  /*
   * A count, not the ids. Deployment ids are caller-adjacent and unbounded, and the one
   * question this record has to answer — whether a panel got a history to choose from — is
   * answered by the number and the flag beside it.
   */
  log.info("deployments.read", {
    service_id: serviceId,
    deployment_count: entries.length,
    refused,
  });

  /*
   * The same memory of a stop the container list is rendered through. Applied here too, or
   * the two surfaces contradict each other on one screen: the row badge says Removed and
   * the newest entry in the panel it expands into says Running, because the history is a
   * second, independent producer of `ContainerState` from the same raw status.
   * See lib/railway/stopped.ts.
   */
  return Response.json(
    { deployments: applyStoppedToHistory(serviceId, entries), refused },
    { headers: { "cache-control": "no-store" } },
  );
}
