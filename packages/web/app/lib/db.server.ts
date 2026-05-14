// Host-root + per-Doco directory helpers. Durable storage is Postgres;
// the remaining file-system helpers exist only to locate `doco.yaml`
// bootstrap stubs and the on-disk markdown/yaml files that round-trip
// with the PG `raw_yaml` column.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let cachedRoot: string | null = null;
let watcherStarted = false;

function startAutoReindexOnce(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  import("./auto-reindex.server")
    .then((m) => m.ensureWatcherStarted())
    .catch((e) => console.error("auto-reindex: failed to start:", e));
}

/**
 * Find the host root — the directory that contains `docos/<owner>/<slug>/`
 * subdirectories. Each subdirectory holds the Doco's `doco.yaml`
 * bootstrap stub plus the on-disk entity files; durable storage is
 * Postgres.
 *
 * Resolution order: DOCO_ROOT env var, otherwise walk upward from cwd
 * looking for a `docos/` subdirectory.
 */
export function rootDir(): string {
  if (cachedRoot) {
    startAutoReindexOnce();
    return cachedRoot;
  }
  const fromEnv = process.env.DOCO_ROOT;
  if (fromEnv && existsSync(join(fromEnv, "docos"))) {
    cachedRoot = resolve(fromEnv);
    startAutoReindexOnce();
    return cachedRoot;
  }
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "docos"))) {
      cachedRoot = dir;
      startAutoReindexOnce();
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Postgres-storage mode (serverless functions, no on-disk docos/):
  // return cwd as a benign placeholder. Downstream filesystem reads
  // already guard with existsSync and degrade to empty results; the
  // canonical lookups (principal-by-username, doco-by-slug) happen via
  // Postgres in this mode and don't need a host root.
  if (process.env.DOCO_STORAGE === "postgres") {
    cachedRoot = process.cwd();
    return cachedRoot;
  }
  throw new Error(
    "Could not find host root. Set DOCO_ROOT or run from inside a directory that contains `docos/`.",
  );
}

export function docoPath(ownerSlug: string, docoSlug: string): string {
  return join(rootDir(), "docos", ownerSlug, docoSlug);
}

export function readDocoFullSlug(ownerSlug: string, docoSlug: string): string {
  return `${ownerSlug}/${docoSlug}`;
}
