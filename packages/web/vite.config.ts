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
  // Force a single React copy across dynamic chunks — without this,
  // @xyflow/react ends up with a duplicate React and crashes with
  // "Cannot read properties of null (reading 'useState')".
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["@xyflow/react", "frimousse"],
  },
  // pg uses native bindings and must not be bundled. @xyflow/react and
  // frimousse are client-only — keep them out of the SSR bundle so they
  // never try to call useRef/useState on a server-side null React.
  ssr: {
    external: ["pg", "@xyflow/react", "frimousse"],
    noExternal: [
      "@doco/api",
      "@doco/core",
      "@doco/db",
      "@doco/host",
      "@doco/index",
      "@doco/lints",
      "@doco/shared",
    ],
  },
});
