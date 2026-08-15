import { type NextRequest } from "next/server";
import { requireSessionOrUnauthorized } from "@/lib/auth/route-guard";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { REGISTRY, LIMITS } from "@/lib/constants";
import { IMAGE_PATTERN } from "@/lib/registry/reference";
import { checkImage } from "@/lib/registry/probe";
import { acquireStreamSlot } from "@/lib/stream-slots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether a registry will admit an image reference exists. Advisory, and nothing more.
 *
 * A fourth kind of route handler, and the first that is not a stream — so it is worth
 * saying why it is one at all rather than a Server Action or a data loader. Two reasons,
 * and either would be enough. The lane rule in `.ai/rules/architecture.md` reserves
 * `dashboard/data.ts` for Server Components and `dashboard/actions.ts` for writes, and this
 * is a read a client component makes mid-interaction; putting it in the write lane would
 * make the only `"use server"` file in the repo something other than what it says it is.
 * And a route handler is the only lane with the inbound `AbortSignal`, which a check that
 * fires as someone types needs — every keystroke that lands cancels the request before it.
 *
 * The answer is one of four enum members and never anything a registry wrote. Nothing on
 * this path reads a response body from upstream except a token, which is never returned.
 */
export async function GET(request: NextRequest) {
  return withRequestScope("/api/image-check", { trustInboundId: true }, () =>
    handle(request),
  );
}

async function handle(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get("ref") ?? "";

  /*
   * Cheapest refusal first, before the session read, exactly as the watch route holds its
   * ids to RAILWAY_ID_PATTERN before doing anything expensive.
   *
   * The reference itself is not logged, at any level. It is an unbounded attacker-chosen
   * string arriving on a URL, which is the same call the stream route makes about a
   * rejected deploymentId — `ref_length` carries the diagnostic content instead. This
   * endpoint fires on every settled keystroke of every signed-in visitor, so it is the
   * worst possible field to hand an operator's log store.
   */
  if (!ref || ref.length > LIMITS.IMAGE_REF_MAX || !IMAGE_PATTERN.test(ref)) {
    log.debug("image.check_rejected", {
      reason: "invalid_ref",
      ref_length: ref.length,
    });
    return Response.json({ status: "unsupported" }, { status: 400 });
  }

  const session = await requireSessionOrUnauthorized("image.check_rejected");
  if (session instanceof Response) return session;

  /*
   * The same counter the log streams and the project watcher use, under a third namespaced
   * key. It bounds how many probes one user can have in flight at once — not how many they
   * can make, which the answer cache and the per-registry cool-off in lib/registry/probe.ts
   * are what bound. Saying that out loud because a concurrency slot reads like a rate limit
   * and is not one.
   */
  const release = acquireStreamSlot(
    `image-check:${session.user.id}`,
    REGISTRY.MAX_CONCURRENT_PER_USER,
  );
  if (!release) {
    log.debug("image.check_rejected", { reason: "slot_limit" });
    return new Response("Too Many Requests", { status: 429 });
  }

  const startedAt = Date.now();
  try {
    const { status, cached, registry } = await checkImage(ref, request.signal);

    // Every field here is drawn from a closed set: four statuses, four registry labels, a
    // boolean and a duration. Nothing the caller chose reaches the record.
    log.info("image.checked", {
      registry,
      outcome: status,
      cached,
      duration_ms: Date.now() - startedAt,
    });

    return Response.json({ status }, { headers: { "cache-control": "no-store" } });
  } finally {
    release();
  }
}
