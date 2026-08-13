import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = {
  "@": path.resolve(import.meta.dirname, "src"),
  // `server-only` throws by design outside a React Server Component graph.
  // Tests exercise those modules directly, so it is stubbed out here.
  "server-only": path.resolve(import.meta.dirname, "src/test/noop.ts"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
          setupFiles: ["src/test/setup.ts", "src/test/setup-intl.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "component",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          /*
           * setup-intl is here too, so a Server Component that reads copy through
           * `getTranslations` can be rendered by awaiting it. Without it the async
           * components — the header, the footer, the container section — were only
           * ever exercised end-to-end. It is additive: setup-dom mocks `next-intl`
           * for client components, setup-intl mocks `next-intl/server`, and the two
           * cover different modules.
           */
          setupFiles: [
            "src/test/setup.ts",
            "src/test/setup-dom.ts",
            "src/test/setup-intl.ts",
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.integration.test.ts"],
          setupFiles: ["src/test/setup.ts", "src/test/setup-intl.ts"],
        },
      },
    ],

    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**"],
      exclude: [
        "src/test/**",
        "src/**/*.d.ts",
        "src/**/*.test.*",
        /*
         * Framework shells: these are React Server Components and route boundaries
         * whose behaviour is composition. They are covered end-to-end by Playwright
         * (e2e/), which does not feed this number — counting them here would either
         * inflate the figure or invite render tests that assert nothing.
         *
         * Everything with logic in it — lib, hooks, components, Server Actions, data
         * loaders and API route handlers — is inside the gate.
         */
        "src/app/**/layout.tsx",
        "src/app/**/page.tsx",
        "src/app/**/loading.tsx",
        "src/app/**/error.tsx",
        "src/app/**/not-found.tsx",
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
