import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let cachedRoot: string | null = null;

/**
 * Find the configured root: DOCO_ROOT env var first (must contain doco.yaml
 * OR host.yaml), otherwise walk upward from cwd looking for either marker.
 */
export function rootDir(): string {
  if (cachedRoot) return cachedRoot;
  const fromEnv = process.env.DOCO_ROOT;
  if (fromEnv && (existsSync(join(fromEnv, "doco.yaml")) || existsSync(join(fromEnv, "host.yaml")))) {
    cachedRoot = resolve(fromEnv);
    return cachedRoot;
  }
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "doco.yaml")) || existsSync(join(dir, "host.yaml"))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not find doco.yaml or host.yaml. Set DOCO_ROOT or run `react-router dev` from inside an Doco or Host.",
  );
}

/** ADR-061 dual-mode detection. */
export function getMode(): "host" | "single-doco" {
  const root = rootDir();
  if (existsSync(join(root, "host.yaml"))) return "host";
  return "single-doco";
}

/** Single-Doco mode: open .doco/cache.db at the root. */
export function openDb(): Database {
  const root = rootDir();
  return new BetterSqlite3(join(root, ".doco", "cache.db"), {
    readonly: true,
    fileMustExist: true,
  });
}

export function getDocoSlug(): string {
  const db = openDb();
  try {
    const row = db.prepare("SELECT slug FROM doco_root LIMIT 1").get() as
      | { slug: string }
      | undefined;
    return row?.slug ?? "?";
  } finally {
    db.close();
  }
}

/**
 * Host mode: resolve a per-Doco cache db. The Doco lives at
 * `<host-root>/docos/<owner>/<slug>/`.
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

/** Read doco.yaml.slug from the Doco's source files (no db needed). */
export function readDocoFullSlug(ownerSlug: string, docoSlug: string): string {
  return `${ownerSlug}/${docoSlug}`;
}
