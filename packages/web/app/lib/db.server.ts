// Host-root path helpers. Durable storage is Postgres; nothing the web
// app reads or writes lives on disk. The helpers here only resolve a
// `<root>/docos/<owner>/<slug>/` path that older CLI flows (init,
// import, export) still address — they are passed downward as
// scaffolding hints, never read as authority.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let cachedRoot: string | null = null;
let watcherStarted = false;

function startAutoReindexOnce(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  // No-op in Postgres-storage mode: nothing on disk to watch — Postgres
  // is source-of-truth and derived data is reindexed at write time.
  // The watcher only runs in the legacy CLI filesystem mode.
  if (process.env.DOCO_STORAGE === "postgres") return;
  import("./auto-reindex.server")
    .then((m) => m.ensureWatcherStarted())
    .catch((e) => console.error("auto-reindex: failed to start:", e));
}

/**
 * Resolve the host root path that older CLI flows (init/import/export)
 * still address. Durable storage is Postgres — the on-disk
 * `<root>/docos/<owner>/<slug>/` tree is no longer authoritative for
 * the web app.
 *
 * Resolution order: DOCO_ROOT env var, otherwise walk upward from cwd
 * looking for a `docos/` subdirectory. In Postgres-storage mode (the
 * default for serverless deployments) we fall back to cwd as a benign
 * placeholder — see the comment in the fallback branch.
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
  // return cwd as a benign placeholder. The canonical lookups
  // (principal-by-username, doco-by-slug) go through Postgres and
  // don't need a host root; the few downstream callers that still
  // address `<root>/docos/...` guard with existsSync and degrade to
  // empty results.
  if (process.env.DOCO_STORAGE === "postgres") {
    cachedRoot = process.cwd();
    return cachedRoot;
  }
  throw new Error(
    "Could not find host root. Set DOCO_STORAGE=postgres for serverless, " +
      "or set DOCO_ROOT / run from inside a directory that contains `docos/` " +
      "for legacy CLI mode.",
  );
}

export function docoPath(ownerSlug: string, docoSlug: string): string {
  return join(rootDir(), "docos", ownerSlug, docoSlug);
}

export function readDocoFullSlug(ownerSlug: string, docoSlug: string): string {
  return `${ownerSlug}/${docoSlug}`;
}
