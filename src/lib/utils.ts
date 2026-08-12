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
 * Elapsed time, in the reader's locale.
 *
 * `Intl.RelativeTimeFormat` rather than hand-built strings: it owns the plural forms,
 * the digit system, and whether the marker precedes or follows the number — all of
 * which the previous `${n}s ago` version got wrong outside English.
 *
 * Returns null for a missing or unparseable timestamp so the caller supplies its own
 * placeholder from the catalog, rather than this returning an em dash nobody can
 * translate.
 */
export function relativeTime(
  iso: string | null | undefined,
  locale: string,
): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;

  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return format.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
}
