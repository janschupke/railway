import { headers } from "next/headers";
import {
  REQUEST_ID_PATTERN,
  newRequestId,
  runWithRequestContext,
} from "@/lib/log/context";

/**
 * Enters the request-scoped logging context.
 *
 * The proxy and the render are separate invocations — Next says so explicitly, and
 * prescribes headers as the channel between them ("Proxy is meant to be invoked
 * separately of your render code and in optimized cases deployed to your CDN, you should
 * not attempt relying on shared modules or globals"). So the proxy stamps `x-request-id`
 * onto the forwarded headers, exactly as it already does for the CSP nonce, and this
 * picks it up on the far side.
 *
 * `route` is the static pattern rather than the concrete path, so it stays a bounded
 * label rather than an unbounded one.
 */
export async function withRequestScope<T>(
  route: string,
  options: { trustInboundId: boolean },
  run: () => Promise<T>,
): Promise<T> {
  return runWithRequestContext({ requestId: await resolveId(options), route }, run);
}

/**
 * A client-supplied id is never adopted on a path the proxy covers, because the proxy
 * overwrites the header unconditionally — an attacker-chosen id is a log-injection
 * vector, an unbounded-cardinality vector for Loki, and a way to stitch requests onto
 * someone else's correlation chain.
 *
 * The auth routes are the exception that makes this a parameter rather than a constant:
 * the proxy matcher excludes `api/auth`, so what arrives there is raw client input and
 * must be ignored. Even where the header is trusted it is validated first, so a malformed
 * one degrades to a fresh id rather than to a poisoned field.
 */
async function resolveId(options: { trustInboundId: boolean }): Promise<string> {
  if (!options.trustInboundId) return newRequestId();

  /*
   * `headers()` throws outside a request scope rather than returning empty, so without
   * this catch the wrapper could take down the very handler it instruments — and
   * instrumentation that can fail the thing it observes is worse than none. The same
   * rule that governs LOG_LEVEL: degrade to a fresh id, never refuse to run.
   */
  try {
    const inbound = (await headers()).get("x-request-id");
    if (inbound && REQUEST_ID_PATTERN.test(inbound)) return inbound;
  } catch {
    // No request scope — a direct call from a test or a script.
  }
  return newRequestId();
}
