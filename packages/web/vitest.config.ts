import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.tsx", "src/**/__tests__/**/*.test.tsx"],
    globals: false,
    testTimeout: 30_000,
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
  },
});
