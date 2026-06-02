import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests (*.integration.test.ts) — require a local Postgres.
// db-isolation creates a throwaway database per file (create → truncate →
// drop), so these are NOT run by `pnpm test` or CI (neither has Postgres).
// Run them against a dev Postgres with:
//   pnpm --filter @doco/web test:integration
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    include: ["app/**/*.integration.test.ts", "src/**/*.integration.test.ts"],
    globals: false,
    testTimeout: 30_000,
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
});
