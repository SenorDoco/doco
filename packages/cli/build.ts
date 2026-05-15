import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

// Anything in `dependencies` that ISN'T a workspace package stays as an
// external import — npm resolves it at install time. Workspace deps are
// inlined into the bundle so the published tarball is self-contained.
const externalRuntime = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !name.startsWith("@doco/"),
);

const distDir = join(here, "dist");
if (existsSync(distDir)) rmSync(distDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [join(here, "src", "index.ts")],
  outfile: join(distDir, "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: externalRuntime,
  logLevel: "info",
  legalComments: "none",
  treeShaking: true,
  sourcemap: false,
});

// @doco/db's ensureSchema() reads schema.sql via fileURLToPath(import.meta.url)
// at runtime. In the published tarball the bundle lives at dist/index.js, so
// the schema needs to sit at dist/schema.sql for the existing path search to
// resolve. Copying here keeps @doco/db's source unchanged.
const schemaSrc = join(here, "..", "db", "src", "schema.sql");
if (existsSync(schemaSrc)) {
  copyFileSync(schemaSrc, join(distDir, "schema.sql"));
} else {
  console.warn(`[doco-cli build] schema.sql not found at ${schemaSrc}`);
}

console.log("[doco-cli build] done");
