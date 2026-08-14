import type { Instrumentation } from "next";
import { env } from "@/env";
import { log } from "@/lib/logger";

/**
 * The one failure class the rest of this app cannot see.
 *
 * A throw during a Server Component render never reaches `reportError` — it unwinds into
 * Next's own boundary, which renders `dashboard/error.tsx` and hands the browser a
 * `digest`. The user is shown that digest as a reference, and until now it referred to
 * nothing: Next's stderr dump is unstructured and carries no field to join on.
 *
 * `onRequestError` is Next's hook for exactly this. Recording the digest as a field makes
 * the reference on screen a query, which is the same contract `incident` already has for
 * everything that fails outside a render.
 *
 * `register()` is Next's other hook here — it runs once, before the first request — and it
 * is where an OTel SDK would go. What it does today is say what the deployment is, because
 * the alternative was reading a platform's word for it.
 */

/**
 * One line, at boot, naming what this process is and whether it can work.
 *
 * A Railway healthcheck failure is a single line in a dashboard that says a request did
 * not succeed. It cannot distinguish a container that never started, one listening on an
 * address the platform does not route to, and one that started perfectly and is answering
 * 503 because `SESSION_SECRET` was never set — and /api/health returns exactly that 503 by
 * design, so the healthiest possible deployment of a misconfigured service looks identical
 * to a broken one.
 *
 * Both the port and the bind address are here, and the address is the newer half. Under
 * `next start` it could not be: that server read PORT and ignored HOSTNAME — measured, by
 * setting HOSTNAME=127.0.0.1 and watching the container carry on listening on `:::3000` —
 * so reporting an address would have meant echoing a variable nothing read. The standalone
 * server reads both, and an address it took from the environment is worth exactly as much
 * as a port it took from the environment.
 *
 * The defaults below are server.js's own, so an unset variable is reported as the value it
 * produced rather than as a blank. `0.0.0.0` appearing in this line is itself the finding:
 * it is the IPv4 wildcard and no IPv6 interface, the Dockerfile sets `::` instead, and a
 * deployment that says `0.0.0.0` is one that lost that line somewhere.
 *
 * Failure is logged, not thrown. Throwing here kills the boot, which loses the log to the
 * crash and leaves the operator with a restart loop instead of a sentence; serving is also
 * what lets /api/health report `misconfigured` rather than refusing the connection.
 */
export function register(): void {
  /*
   * The edge runtime gets its own instance of this module and has no stdout to write to —
   * the same reason logger.ts is careful about `process.stdout`. The node runtime is the
   * one that binds the port, so it is the only one with anything to report.
   */
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // server.js's own fallbacks, so the line is never blank about either.
  const listening = {
    port: process.env.PORT ?? "3000",
    hostname: process.env.HOSTNAME ?? "0.0.0.0",
  };

  try {
    env();
  } catch (error) {
    /*
     * The issue list names every variable that is missing or malformed — the same detail
     * /api/health writes when it answers 503, moved to the moment it becomes true rather
     * than repeated once per healthcheck attempt. It names variables, never values.
     */
    log.error("boot.env_invalid", {
      ...listening,
      issues: (error as Error).message,
    });
    return;
  }

  log.info("boot", listening);
}

/**
 * A render that stopped because the browser navigated away, which is not a failure.
 *
 * Next reports it through the same hook as a genuine throw, and at `error` it fires on
 * ordinary fast navigation — the same false positive that teaches people to ignore the
 * level. Matching on the message is admittedly fragile, and deliberately so in the safe
 * direction: if Next rewords it, a benign line comes back at `error`, which is visible
 * and harmless rather than a real failure going quiet.
 */
const CLIENT_DISCONNECT = "The destination stream closed early.";

/**
 * The request path, reduced to the app's own route shapes.
 *
 * `request.path` is the concrete URL path, so a 404 storm against /aaa, /aab, /aac wrote
 * a new field value per request into a field meant to be grouped on — and the paths are
 * chosen by whoever sent them. `onRequestError`'s context carries routerKind, routeType
 * and renderSource but not the matched route pattern, so this derives a bounded stand-in
 * from the first segment instead of reporting the concrete path.
 */
const ROUTE_GROUPS = new Set(["dashboard", "api"]);

function routeGroup(path: string): string {
  const [, first] = path.split("?", 1)[0]!.split("/");
  if (!first) return "/";
  return ROUTE_GROUPS.has(first) ? `/${first}` : "other";
}

export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
  context,
) => {
  const benign = error instanceof Error && error.message === CLIENT_DISCONNECT;

  log[benign ? "debug" : "error"]("render.failed", {
    error,
    digest:
      typeof error === "object" && error !== null && "digest" in error
        ? String((error as { digest: unknown }).digest)
        : undefined,
    route_group: routeGroup(request.path),
    router: context.routerKind,
    route_type: context.routeType,
    render_source: context.renderSource,
  });
};
