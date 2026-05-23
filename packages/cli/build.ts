import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

const externalRuntime = Object.keys(pkg.dependencies ?? {});

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

console.log("[doco-cli build] done");
