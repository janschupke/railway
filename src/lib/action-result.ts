import { SessionExpiredError } from "@/lib/auth/refresh";
import { RailwayApiError } from "@/lib/railway/errors";

/** Field names a Server Action can attribute an error to. */
export type ActionField = "name" | "image";

export type ActionResult =
  { ok: true; message: string } | { ok: false; error: string; field?: ActionField };

/**
 * Turns any thrown value into something safe to render.
 *
 * Every branch produces a message written for the person who clicked the button, never
 * a raw API string, and never anything derived from the access token.
 */
export function toActionError(error: unknown): ActionResult {
  if (error instanceof SessionExpiredError) {
    return { ok: false, error: "Your Railway session expired. Sign in again." };
  }
  if (error instanceof RailwayApiError) {
    return { ok: false, error: error.userMessage() };
  }
  return { ok: false, error: "Something went wrong. Please try again." };
}

export function isField(value: unknown): value is ActionField {
  return value === "name" || value === "image";
}
