import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
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
