import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // `server-only` throws by design outside a React Server Component graph.
      // Tests exercise those modules directly, so it is stubbed out here.
      "server-only": path.resolve(import.meta.dirname, "src/test/noop.ts"),
    },
  },
});
