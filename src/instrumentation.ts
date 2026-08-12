import type { Instrumentation } from "next";
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
 * No `register()` yet. That is where an OTel SDK goes, and an empty one now would be
 * noise; the point of this file existing already is that the OTel step adds one export
 * here and changes nothing else.
 */
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
    path: request.path,
    router: context.routerKind,
    route_type: context.routeType,
    render_source: context.renderSource,
  });
};
