import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * The one asset another origin is allowed to load.
 *
 * Two files have to agree on it: this one grants the cross-origin read, and src/proxy.ts
 * keeps it out of the session matcher so the fetch pays no HKDF derive. Not shared as an
 * import — this module is build-time config, and pulling it into the runtime proxy would
 * drag the next-intl plugin along with it — so src/app/security-headers.test.ts asserts
 * the two agree instead.
 */
const PUBLIC_ICON = "icon.svg";

/**
 * Response headers that never vary per request. The Content-Security-Policy is not
 * here — it carries a per-request nonce, so it is written in src/proxy.ts, and one
 * writer is what stops the two disagreeing.
 *
 * Cross-Origin-Resource-Policy is not here either, for a different reason: it is the one
 * value that is not the same on every path. See headers() below.
 */
const SECURITY_HEADERS = [
  // No `preload`: this deploys under Railway's own domain, and submitting someone
  // else's domain to the preload list is not this app's call to make.
  { key: "strict-transport-security", value: "max-age=63072000; includeSubDomains" },
  // /api/streams echoes container stdout back as text/event-stream, so sniffing that
  // response is exactly the case this prevents.
  { key: "x-content-type-options", value: "nosniff" },
  // Belt and braces with frame-ancestors, for pre-CSP2 agents. Destroy is guarded by a
  // typed confirmation, but spin-up is one click and creates billable infrastructure.
  { key: "x-frame-options", value: "DENY" },
  { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
  { key: "cross-origin-opener-policy", value: "same-origin" },
  {
    key: "permissions-policy",
    value: [
      "accelerometer=()",
      "autoplay=()",
      "camera=()",
      "display-capture=()",
      "encrypted-media=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "picture-in-picture=()",
      "publickey-credentials-get=()",
      "screen-wake-lock=()",
      "usb=()",
      "xr-spatial-tracking=()",
    ].join(", "),
  },
];

const nextConfig: NextConfig = {
  // Framework fingerprinting on every response, for no benefit.
  poweredByHeader: false,

  async headers() {
    /*
     * ":path*" so static chunks and fonts get nosniff too — the proxy deliberately
     * does not run for those, since it would pay a JWE decrypt per asset.
     *
     * Cross-Origin-Resource-Policy is declared separately because the app icon is the
     * one response here that is *meant* to be read by another origin. `same-origin` on
     * it made the mark unusable in a README, a link preview or anything else that embeds
     * it by URL — the file was already public, since src/proxy.ts excludes it from the
     * session matcher, and this header was quietly refusing the only use it has off-site.
     *
     * `cross-origin` grants exactly that and nothing more: a foreign document may load
     * the bytes. It is not CORS — no credentials are sent and no script gets a readable
     * body. Everything else keeps `same-origin`, which is what stops another site
     * embedding a page or an API response from this app while a session cookie is live.
     *
     * Order is load-bearing: Next applies matching rules in order and a later value for
     * the same key wins, so the blanket rule comes first and the icon overrides it.
     * Reversed, the icon silently keeps the restrictive value and every other route
     * silently loses it — one failure invisible until someone embeds the mark, the other
     * a real weakening. src/app/security-headers.test.ts asserts the order rather than
     * trusting it, and e2e/security.spec.ts reads both values off a live response.
     */
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        source: "/:path*",
        headers: [{ key: "cross-origin-resource-policy", value: "same-origin" }],
      },
      {
        source: `/${PUBLIC_ICON}`,
        headers: [{ key: "cross-origin-resource-policy", value: "cross-origin" }],
      },
    ];
  },

  experimental: {
    /*
     * `radix-ui` is a single barrel re-exporting every primitive, and unlike
     * `lucide-react` it is not on Next's default optimize list — so importing Tooltip
     * pulled the whole package's module graph into the route chunk.
     */
    optimizePackageImports: ["radix-ui"],
  },
};

export default withNextIntl(nextConfig);
