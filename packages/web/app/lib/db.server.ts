import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let cachedRoot: string | null = null;
let watcherStarted = false;

/**
 * Start the auto-reindex filesystem watcher (idempotent). Lazy-import so
 * the watcher's deps (fs.watch + reindex) aren't loaded unless something
 * actually opens a Doco. Per `auto-reindex-on-file-changes` Intent.
 */
function startAutoReindexOnce(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  // Lazy dynamic import so this module stays tree-shakeable in test envs.
  import("./auto-reindex.server")
    .then((m) => m.ensureWatcherStarted())
    .catch((e) => console.error("auto-reindex: failed to start:", e));
}

/**
 * Find the host root — the directory that contains `docos/<owner>/<slug>/`
 * subdirectories where per-clone SQLite caches live. Host config itself
 * is in Postgres now (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids
 * back-compat). The root is needed only to locate the regenerable
 * cache.db files; it doesn't carry source-of-truth.
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
  throw new Error(
    "Could not find host root. Set DOCO_ROOT or run from inside a directory that contains `docos/`.",
  );
}

/**
 * Resolve a per-Doco cache. The Doco lives at `<host-root>/docos/<owner>/<slug>/`.
 */
export function docoPath(ownerSlug: string, docoSlug: string): string {
  return join(rootDir(), "docos", ownerSlug, docoSlug);
}

export function openDocoDb(ownerSlug: string, docoSlug: string): Database {
  return openDocoDbAtDir(docoPath(ownerSlug, docoSlug));
}

/**
 * Open the SQLite cache directly from a Doco directory path. The cache
 * is the read-side index built from Postgres rows; sync queries here are
 * fine. Used by capture helpers that resolve scope names / principals
 * from the cache rather than walking the filesystem.
 */
export function openDocoDbAtDir(docoDir: string): Database {
  const cache = join(docoDir, ".doco", "cache.db");
  if (!existsSync(cache)) {
    throw new Response(
      `No index at ${docoDir}. Run \`doco reindex --root ${docoDir}\` first.`,
      { status: 404 },
    );
  }
  return new BetterSqlite3(cache, { readonly: true, fileMustExist: true });
}

export function readDocoFullSlug(ownerSlug: string, docoSlug: string): string {
  return `${ownerSlug}/${docoSlug}`;
}
