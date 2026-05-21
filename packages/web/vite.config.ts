import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Build-time stamps surfaced as `__DOCO_VERSION__` / `__DOCO_RELEASE_AT__`
// in the client. During alpha, version means "which deployed build is this?"
// rather than the static package.json semver. Prefer Vercel's system metadata,
// then local git, then package.json as the local-development fallback.
const rootDir = resolve(import.meta.dirname, "../..");
const rootPkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf-8")) as {
  version: string;
};
function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function git(command: string): string | null {
  try {
    return clean(execSync(command, { cwd: rootDir }).toString());
  } catch {
    return null;
  }
}

const vercelGitSha = clean(process.env.VERCEL_GIT_COMMIT_SHA);
const vercelDeploymentId = clean(process.env.VERCEL_DEPLOYMENT_ID);
const version =
  clean(process.env.DOCO_VERSION) ??
  (vercelGitSha ? vercelGitSha.slice(0, 7) : null) ??
  (vercelDeploymentId ? vercelDeploymentId.replace(/^dpl_/, "").slice(0, 8) : null) ??
  git("git rev-parse --short=7 HEAD") ??
  rootPkg.version;
const releaseAt = git("git log -1 --format=%cI") ?? new Date().toISOString();

function findAssetDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "assets") out.push(path);
      out.push(...findAssetDirs(path));
    }
  }
  return out;
}

function copyDbSchemaIntoServerBuild(): Plugin {
  return {
    name: "doco-copy-db-schema",
    apply: "build",
    closeBundle() {
      const schemaSrc = resolve(rootDir, "packages/db/src/schema.sql");
      const migrationsSrcDir = resolve(rootDir, "packages/db/migrations");
      const migrationFiles = existsSync(migrationsSrcDir)
        ? readdirSync(migrationsSrcDir).filter((f) => f.endsWith(".sql"))
        : [];
      const serverRoot = resolve(import.meta.dirname, "build/server");
      for (const assetDir of findAssetDirs(serverRoot)) {
        copyFileSync(schemaSrc, join(assetDir, "schema.sql"));
        // Migrations: `locateMigrationsDir()` in @doco/db walks up from
        // its own location; the bundled migrations.js sits inside the
        // asset dir, so a sibling `migrations/` here lands inside one
        // of the candidate `../migrations` / `../../migrations` paths.
        if (migrationFiles.length > 0) {
          const dest = join(assetDir, "migrations");
          mkdirSync(dest, { recursive: true });
          for (const f of migrationFiles) {
            copyFileSync(join(migrationsSrcDir, f), join(dest, f));
          }
        }
      }
    },
  };
}

export default defineConfig({
  define: {
    __DOCO_VERSION__: JSON.stringify(version),
    __DOCO_RELEASE_AT__: JSON.stringify(releaseAt),
  },
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths(), copyDbSchemaIntoServerBuild()],
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
      "lucide-react",
      "tailwind-merge",
      "yaml",
    ],
  },
  // pg uses native bindings and must not be bundled. @xyflow/react is
  // client-only — keep it out of the SSR bundle so it never tries to call
  // useRef/useState on a server-side null React.
  //
  // @dagrejs/dagre is bundled into the SSR chunk (noExternal) because
  // Vercel's serverless runtime loads its `dist/dagre.esm.js` file via
  // the CJS loader, which fails on `export {...}` with
  // `SyntaxError: Unexpected token 'export'`. Inlining sidesteps the
  // runtime resolution entirely. (Used server-side by entity-graph's
  // SSR layout pass.)
  ssr: {
    external: ["pg", "@xyflow/react"],
    noExternal: [
      "@doco/db",
      "@doco/host",
      "@doco/index",
      "@doco/shared",
      "@dagrejs/dagre",
    ],
  },
});
