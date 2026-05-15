import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Build-time stamps surfaced as `__DOCO_VERSION__` / `__DOCO_RELEASE_AT__`
// in the client. Version comes from the monorepo root package.json (the
// single source of truth for "what version of Doco is this"). Release
// timestamp is the most recent git commit on the deployed tree — for an
// alpha with no tags, "released" === "last commit shipped". Falls back to
// `Date.now()` if git isn't available (e.g. shallow CI container).
const rootDir = resolve(import.meta.dirname, "../..");
const rootPkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf-8")) as {
  version: string;
};
let releaseAt: string;
try {
  releaseAt = execSync("git log -1 --format=%cI", { cwd: rootDir }).toString().trim();
} catch {
  releaseAt = new Date().toISOString();
}

export default defineConfig({
  define: {
    __DOCO_VERSION__: JSON.stringify(rootPkg.version),
    __DOCO_RELEASE_AT__: JSON.stringify(releaseAt),
  },
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
  // Pre-bundle every client-runtime dep so Vite doesn't re-optimize on
  // the first navigation that loads a new one. Re-optimization rotates
  // the browserHash, which orphans chunks the page is mid-loading and
  // crashes React with "Cannot read properties of null (reading
  // 'useState' / 'useContext')" — duplicate-React symptom, same root.
  // Anything imported from app/ that lives in node_modules belongs here.
  // React + react-dom + jsx runtimes are listed explicitly: leaving them
  // to auto-discovery means Vite optimizes the rest of the deps first,
  // then re-optimizes when an app module imports React → browserHash
  // rotates mid-load → orphaned chunks → duplicate-React crash on the
  // entity-detail page (the first page to dynamic-import @xyflow/react).
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-router",
      "react-router/dom",
      "@xyflow/react",
      "class-variance-authority",
      "clsx",
      "frimousse",
      "lucide-react",
      "tailwind-merge",
      "yaml",
    ],
  },
  // pg uses native bindings and must not be bundled. @xyflow/react and
  // frimousse are client-only — keep them out of the SSR bundle so they
  // never try to call useRef/useState on a server-side null React.
  ssr: {
    external: ["pg", "@xyflow/react", "frimousse"],
    noExternal: [
      "@doco/db",
      "@doco/host",
      "@doco/index",
      "@doco/lints",
      "@doco/shared",
    ],
  },
});
