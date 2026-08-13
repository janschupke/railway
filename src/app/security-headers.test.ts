import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { config as proxyConfig } from "@/proxy";

/**
 * The header table, asserted rather than read.
 *
 * next.config.ts returns three rules whose *order* is load-bearing: a blanket
 * Cross-Origin-Resource-Policy of `same-origin`, then `cross-origin` for the app icon
 * alone. Reversed, the icon silently keeps the restrictive value and every other route
 * silently loses it — the first is invisible until someone tries to embed the mark, and
 * the second is a real weakening that nothing else in the repo would notice.
 */
const rules = async () => {
  const headers = await nextConfig.headers?.();
  if (!headers) throw new Error("next.config.ts declares no headers()");
  return headers;
};

/** The last value declared for `key` on `source`, which is the one that survives. */
const valueFor = (
  entries: Awaited<ReturnType<typeof rules>>,
  source: string,
  key: string,
) =>
  entries
    .filter((rule) => rule.source === source)
    .flatMap((rule) => rule.headers)
    .filter((header) => header.key === key)
    .at(-1)?.value;

describe("security headers", () => {
  it("lets another origin load the app icon, and nothing else", async () => {
    const entries = await rules();

    expect(valueFor(entries, "/icon.svg", "cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    /*
     * Everything else stays same-origin. This is what stops another site embedding a
     * page or an API response from this app while a visitor's session cookie is live,
     * so the icon's exemption has to be exactly one path wide.
     */
    expect(valueFor(entries, "/:path*", "cross-origin-resource-policy")).toBe(
      "same-origin",
    );
  });

  it("declares the icon's rule after the blanket one", async () => {
    // Next applies matching rules in order and a later value for the same key wins.
    const entries = await rules();
    const index = (source: string) =>
      entries.findIndex(
        (rule) =>
          rule.source === source &&
          rule.headers.some((header) => header.key === "cross-origin-resource-policy"),
      );

    expect(index("/icon.svg")).toBeGreaterThan(index("/:path*"));
  });

  it("keeps the icon out of the session proxy, or the grant buys nothing", async () => {
    /*
     * A cross-origin grant on a path the proxy redirects to the landing page is a header
     * on a 307. The two files have no shared constant — next.config.ts is build-time and
     * importing it into the runtime proxy would drag the next-intl plugin along — so the
     * agreement is asserted here.
     */
    expect(proxyConfig.matcher.join(" ")).toContain("icon.svg");
  });

  it("still applies the rest of the table everywhere", async () => {
    // The blanket rule is what gives static chunks and fonts `nosniff`; the proxy does
    // not run for those, since it would pay a JWE decrypt per asset.
    const entries = await rules();
    const blanket = entries
      .filter((rule) => rule.source === "/:path*")
      .flatMap((rule) => rule.headers)
      .map((header) => header.key);

    for (const key of [
      "strict-transport-security",
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "cross-origin-opener-policy",
      "permissions-policy",
    ]) {
      expect(blanket).toContain(key);
    }
  });
});
