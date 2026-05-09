import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  // better-sqlite3 is a native module and cannot be bundled into the SSR build
  ssr: {
    external: ["better-sqlite3"],
    noExternal: [
      "@evalo/core",
      "@evalo/discovery",
      "@evalo/host",
      "@evalo/index",
      "@evalo/lints",
      "@evalo/shared",
    ],
  },
});
