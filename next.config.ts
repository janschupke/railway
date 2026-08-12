import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Response headers that never vary per request. The Content-Security-Policy is not
 * here — it carries a per-request nonce, so it is written in src/proxy.ts, and one
 * writer is what stops the two disagreeing.
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
  { key: "cross-origin-resource-policy", value: "same-origin" },
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
    // ":path*" so static chunks and fonts get nosniff too — the proxy deliberately
    // does not run for those, since it would pay a JWE decrypt per asset.
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
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
