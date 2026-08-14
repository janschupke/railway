import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { log } from "@/lib/logger";
import { resolveOrigin, type AppOrigin } from "@/lib/origin";

/**
 * The origin for a request the proxy never saw.
 *
 * The three auth routes are excluded from the proxy matcher — they mint the session and
 * must not be gated by it — so nothing has resolved an origin by the time they run, and
 * each has to refuse for itself rather than inherit the proxy's 400. This is that check,
 * written once: three copies of it would be three chances for one of them to be lenient.
 *
 * The record names a bounded reason and never the host, which is whatever the caller
 * wrote. `route` and `request_id` come from the surrounding withRequestScope, so they are
 * not repeated here. `absent` is a caller that sent no Host at all — not a browser, and
 * not worth a warning.
 */
export function requestOrigin(request: NextRequest): AppOrigin | null {
  const { origin, refused } = resolveOrigin(request.headers, env());

  if (refused) {
    log[refused === "absent" ? "debug" : "warn"]("auth.origin_rejected", {
      reason: refused,
      fell_back: origin !== null,
    });
  }

  return origin;
}

/**
 * What a handler answers when the request named no origin it is willing to serve.
 *
 * A NextResponse rather than a bare Response so a handler's return type stays what it was.
 * Nothing about the body needs Next; the callers' tests read `.cookies` off what they get
 * back, and one branch returning a plain Response would take that away from all of them.
 */
export function badOrigin(): NextResponse {
  return new NextResponse("Bad Request", { status: 400 });
}
