import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let cachedRoot: string | null = null;

/**
 * Find the host root. DOCO_ROOT env var first (must contain host.yaml),
 * otherwise walk upward from cwd. Per ADR-093 the host is the only shape;
 * single-doco mode is gone.
 */
export function rootDir(): string {
  if (cachedRoot) return cachedRoot;
  const fromEnv = process.env.DOCO_ROOT;
  if (fromEnv && existsSync(join(fromEnv, "host.yaml"))) {
    cachedRoot = resolve(fromEnv);
    return cachedRoot;
  }
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "host.yaml"))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not find host.yaml. Set DOCO_ROOT or run from inside a Doco host.",
  );
}

/**
 * Resolve a per-Doco cache. The Doco lives at `<host-root>/docos/<owner>/<slug>/`.
 */
export function docoPath(ownerSlug: string, docoSlug: string): string {
  return join(rootDir(), "docos", ownerSlug, docoSlug);
}

export function openDocoDb(ownerSlug: string, docoSlug: string): Database {
  const dir = docoPath(ownerSlug, docoSlug);
  const cache = join(dir, ".doco", "cache.db");
  if (!existsSync(cache)) {
    throw new Response(
      `Doco "${ownerSlug}/${docoSlug}" has no index. Run \`doco reindex --root ${dir}\` first.`,
      { status: 404 },
    );
  }
  return new BetterSqlite3(cache, { readonly: true, fileMustExist: true });
}

export function readDocoFullSlug(ownerSlug: string, docoSlug: string): string {
  return `${ownerSlug}/${docoSlug}`;
}
