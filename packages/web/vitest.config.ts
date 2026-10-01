import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    include: [
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "app/**/__tests__/**/*.test.ts",
      "app/**/__tests__/**/*.test.tsx",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/**/__tests__/**/*.test.ts",
      "src/**/__tests__/**/*.test.tsx",
    ],
    // Integration tests (*.integration.test.ts) need a local Postgres —
    // db-isolation spins up a throwaway DB per file — so they run via
    // `pnpm test:integration`, not `pnpm test`/CI (no Postgres there).
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
    globals: false,
    // Real-DB tests restore the migrated schema from one snapshot per run.
    globalSetup: ["../db/src/__tests__/schema-snapshot.global-setup.ts"],
    // The suite is CPU-bound (PGlite): use every core. Vitest's default leaves
    // one free, which on CI's 2-core runner meant one test file at a time.
    maxWorkers: "100%",
    testTimeout: 30_000,
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
});
