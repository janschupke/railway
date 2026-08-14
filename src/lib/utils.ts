import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The type scale's size utilities, as tailwind-merge needs to be told about them.
 *
 * Must match the `--text-*` keys mapped in globals.css. Out of the box tailwind-merge
 * only knows Tailwind's own `text-xs … text-9xl`, so it classifies `text-caption` as a
 * *colour* — every `text-*` it does not recognise falls into that group — and then
 * drops it as conflicting with the `text-text-muted` sitting beside it in the same
 * `cn()` call. The class simply vanishes from the output and the element renders at
 * whatever it inherited, with nothing in the markup to show why.
 *
 * src/lib/utils.test.ts pins this, because the failure is silent in every other way.
 */
const TYPE_SCALE = [
  "display",
  "title",
  "heading",
  "body",
  "label",
  "caption",
  "mono",
] as const;

const merge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: [...TYPE_SCALE] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}

/**
 * A delay that gives up when its signal aborts.
 *
 * There were two of these: an abortable one inside the watch route and a
 * non-abortable one-liner in the Railway client, which left a retry backoff pinning a
 * timer after the caller had already gone. `signal` is optional so the client uses the
 * same function rather than keeping its own second definition, and an
 * already-aborted signal resolves immediately instead of waiting out the full delay.
 *
 * The listener is removed on the normal path as well as the aborted one. `{ once: true }`
 * only detaches a listener that has *fired*, so a poll loop sleeping on one long-lived
 * signal accumulated a listener per iteration — and Node warns at eleven, which is a
 * MaxListenersExceededWarning naming this file for a leak that is only ever a few
 * closures wide, on the signal that is about to be discarded anyway.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
