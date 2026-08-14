"use client";

import { useEffect, useState } from "react";
import { REGISTRY, LIMITS } from "@/lib/constants";
import { PRESETS } from "@/lib/presets";
import { IMAGE_PATTERN, type ImageCheckStatus } from "@/lib/registry/reference";
import { useDebouncedValue } from "./use-debounced-value";

/** Statuses the route can send. Anything else is a version skew and means nothing. */
const STATUSES: ReadonlySet<string> = new Set<ImageCheckStatus>([
  "available",
  "unavailable",
  "unknown",
  "unsupported",
]);

/**
 * Whether the registry has heard of what is in the image field.
 *
 * Returns null for "no opinion", which is the answer most of the time: while the value is
 * settling, for anything the check declines to make, and for every failure. The caller
 * renders something only for `unavailable`.
 *
 * Imports `IMAGE_PATTERN` from lib/registry/reference rather than lib/validation, and that
 * is a bundle decision rather than a taste one — `lib/validation` imports zod, and one
 * import of it from here would put zod in /dashboard's first load for the sake of a regex.
 * The pattern lives in a module with no imports at all so both sides can hold the same rule.
 */
export function useImageCheck(image: string): ImageCheckStatus | null {
  const current = image.trim();
  const settled = useDebouncedValue(current, REGISTRY.DEBOUNCE_MS);
  /*
   * The answer, and the reference it is about — never the answer alone.
   *
   * Held as a pair and matched on the way out, rather than cleared by an effect, because
   * the moment that matters is a render the effect does not run on. Between a keystroke
   * and the debounce settling, `settled` still holds the previous reference and nothing
   * re-runs; an answer stored on its own would go on describing a value the field no
   * longer contains, which is a worse thing to say than nothing.
   */
  const [answer, setAnswer] = useState<{
    ref: string;
    status: ImageCheckStatus;
  } | null>(null);

  useEffect(() => {
    /*
     * Three reasons not to ask, and the first is the one that matters most.
     *
     * A catalog preset exists by construction, so checking one is a request that can only
     * confirm what the app already knows — and the default value of this field is a preset,
     * so without this every visitor to the dashboard would spend one. Matched on the exact
     * reference, not through `presetFor`: that matches on repository, so it would treat
     * `postgres:99-nonexistent` as a known preset and skip precisely the case worth checking.
     *
     * A reference that fails the pattern is the server's to refuse on submit, and one over
     * the length ceiling would be refused by the route anyway.
     */
    if (!settled) return;
    if (PRESETS.some((preset) => preset.value === settled)) return;
    if (settled.length > LIMITS.IMAGE_REF_MAX) return;
    if (!IMAGE_PATTERN.test(settled)) return;

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(
          `/api/image-check?ref=${encodeURIComponent(settled)}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const body: unknown = await response.json();
        const next =
          typeof body === "object" && body !== null && "status" in body
            ? (body as { status: unknown }).status
            : undefined;
        if (typeof next === "string" && STATUSES.has(next)) {
          setAnswer({ ref: settled, status: next as ImageCheckStatus });
        }
      } catch {
        /*
         * Silent, and it has to be. There is no client-to-server error channel in this app
         * — a hook may not import lib/logger, which writes to a stdout the browser does not
         * have — and there is nothing to say anyway: a check that failed and a check that
         * came back `unknown` put the same nothing on screen.
         */
      }
    })();

    // Cancels the request the next keystroke makes obsolete, and the one in flight when the
    // form unmounts. Without it a slow answer could land on a value nobody is looking at.
    return () => controller.abort();
  }, [settled]);

  return answer && answer.ref === current ? answer.status : null;
}
