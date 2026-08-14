import { LIMITS } from "@/lib/constants";

/**
 * The name a container is given, without the ownership prefix.
 *
 * Split out of ./managed.ts so the spin-up form can call it. That module reads
 * `managedPrefix()` at every entry point and so imports `@/env`, which is zod over
 * `process.env` — it throws in a browser, and importing it from a client component
 * would pull zod into the /dashboard bundle to do it.
 *
 * The form needs exactly this half and no more: it compares what someone has typed
 * against the names already on the page, and those are rendered with the prefix already
 * stripped. So the client never needs to know what the prefix is.
 */
export function managedSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.SERVICE_SLUG_MAX);
  // A name made entirely of punctuation slugs to nothing, and a service still needs one.
  return slug || "container";
}
