import { defineConfig } from "vitest/config";

export default defineConfig({
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
    globals: false,
    testTimeout: 30_000,
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
  },
});
