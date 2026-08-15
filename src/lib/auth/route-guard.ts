import "server-only";

import { log, type LogEvent } from "@/lib/logger";
import { requireSession } from "./server";
import type { RailwaySession } from "./session";

/**
 * `requireSession` for a route handler, which has a Response to give back.
 *
 * Four routes carried this prelude verbatim — the `let session` declaration, the bare
 * catch, the 401, and the same judgement about the log level reworded four ways. The
 * judgement is the thing worth writing once: **debug, not warn**. A tab whose session
 * expired reopens its EventSource in a loop, and the image check fires on every settled
 * keystroke, so at `info` this would be the noisiest line in the system — while carrying
 * nothing an operator can act on, because an expiry is the ordinary end of a session
 * rather than a fault. A fifth route copying a neighbour is how that becomes an `info`
 * somebody has to filter out later.
 *
 * Returns the refusal rather than throwing it, so the caller keeps its own control flow
 * and the shape stays visible at the call site:
 *
 * ```ts
 * const session = await requireSessionOrUnauthorized("stream.rejected");
 * if (session instanceof Response) return session;
 * ```
 *
 * `event` is the route's own rejection event, so the reason joins the same series as that
 * route's 400s rather than arriving under a name shared with three others. Typed as
 * `LogEvent` rather than `string`, so a route inventing a name here fails the same way it
 * would calling `log.debug` directly — this helper is not a hole in that union.
 *
 * Its own module rather than a fifth export from ./server.ts, and that is about testing
 * rather than tidiness: all four route suites replace `@/lib/auth/server` wholesale with a
 * session double, so a helper living there would be replaced along with it and the 401
 * path they each assert would be a stub's. From here it composes over whatever
 * `requireSession` those tests supply, and the branch under test is the real one.
 */
export async function requireSessionOrUnauthorized(
  event: LogEvent,
): Promise<RailwaySession | Response> {
  try {
    return await requireSession();
  } catch {
    log.debug(event, { reason: "unauthenticated" });
    return new Response("Unauthorized", { status: 401 });
  }
}
