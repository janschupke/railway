import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * The only assets another origin is allowed to load: the app's mark, in both forms.
 *
 * `icon.svg` is what the page declares and what a modern browser uses; `favicon.ico`
 * carries the same mark at 16, 32 and 48 for the surfaces that still ask for that path,
 * and browsers request it whether or not it is declared — it was a 404 in the console
 * until it existed. Both are brand assets, so exempting one and not the other would leave
 * whichever a reader picked silently refusing to paint.
 *
 * Two files have to agree on this list: this one grants the cross-origin read, and
 * src/proxy.ts keeps both out of the session matcher so an icon fetch pays no HKDF
 * derive. Not shared as an import — this module is build-time config, and pulling it into
 * the runtime proxy would drag the next-intl plugin along with it — so
 * src/app/security-headers.test.ts asserts the two agree instead.
 */
const PUBLIC_ICONS = ["icon.svg", "favicon.ico"];

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
  /*
   * The runtime image copies `.next/standalone` instead of a production `node_modules`
   * tree. Measured: 504 MB of app payload became 44 MB, because the trace keeps what the
   * server reaches rather than what the lockfile resolves.
   *
   * The difference is not fat, it is other people's peers. pnpm resolves optional peer
   * dependencies at lockfile time and writes them into the resolved package's identity —
   * `next@16.3.0(@babel/core@7.29.7)(@playwright/test@1.62.1)(@types/node@20.19.43)…` —
   * so `--prod` could not drop them: it prunes root devDependencies, and these are part of
   * the name of a production one. That is how typescript, playwright and the Babel closure
   * reached a deployment. Tracing asks a different question and none of them survive it.
   *
   * It also stops this file being read at boot. `next start` compiles next.config.ts on
   * every start, which is why the image carried a native SWC compiler; standalone inlines
   * the resolved config into server.js, and `headers()` below is already baked into
   * .next/routes-manifest.json at build time, so nothing is lost by that.
   *
   * The cost is that `next start` does not serve a standalone build. `pnpm start`,
   * playwright.config.ts and scripts/serve-e2e.ts run `node .next/standalone/server.js`
   * instead, and `postbuild` copies .next/static in — see scripts/pack-standalone.ts.
   */
  output: "standalone",

  /*
   * src/i18n/request.ts loads the catalog with `import(`../../messages/${locale}.json`)`,
   * and tracing is static analysis over `import`, `require` and `fs` — a template literal
   * is exactly the shape it cannot follow. Next's own documentation uses a locale
   * directory as the example for this option.
   *
   * Without it the image builds, starts, answers /api/health and 500s on the first page,
   * which is the same failure the Dockerfile's explicit `COPY messages` used to prevent.
   */
  outputFileTracingIncludes: {
    "/*": ["messages/**/*.json"],
  },

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
      ...PUBLIC_ICONS.map((icon) => ({
        source: `/${icon}`,
        headers: [{ key: "cross-origin-resource-policy", value: "cross-origin" }],
      })),
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
