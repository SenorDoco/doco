import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let cachedRoot: string | null = null;

/**
 * Find the configured root: EVALO_ROOT env var first (must contain evalo.yaml
 * OR host.yaml), otherwise walk upward from cwd looking for either marker.
 */
export function rootDir(): string {
  if (cachedRoot) return cachedRoot;
  const fromEnv = process.env.EVALO_ROOT;
  if (fromEnv && (existsSync(join(fromEnv, "evalo.yaml")) || existsSync(join(fromEnv, "host.yaml")))) {
    cachedRoot = resolve(fromEnv);
    return cachedRoot;
  }
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "evalo.yaml")) || existsSync(join(dir, "host.yaml"))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not find evalo.yaml or host.yaml. Set EVALO_ROOT or run `react-router dev` from inside an Evalo or Host.",
  );
}

/** ADR-061 dual-mode detection. */
export function getMode(): "host" | "single-evalo" {
  const root = rootDir();
  if (existsSync(join(root, "host.yaml"))) return "host";
  return "single-evalo";
}

/** Single-Evalo mode: open .evalo/cache.db at the root. */
export function openDb(): Database {
  const root = rootDir();
  return new BetterSqlite3(join(root, ".evalo", "cache.db"), {
    readonly: true,
    fileMustExist: true,
  });
}

export function getEvaloSlug(): string {
  const db = openDb();
  try {
    const row = db.prepare("SELECT slug FROM evalo_root LIMIT 1").get() as
      | { slug: string }
      | undefined;
    return row?.slug ?? "?";
  } finally {
    db.close();
  }
}

/**
 * Host mode: resolve a per-Evalo cache db. The Evalo lives at
 * `<host-root>/evalos/<owner>/<slug>/`.
 */
export function evaloPath(ownerSlug: string, evaloSlug: string): string {
  return join(rootDir(), "evalos", ownerSlug, evaloSlug);
}

export function openEvaloDb(ownerSlug: string, evaloSlug: string): Database {
  const dir = evaloPath(ownerSlug, evaloSlug);
  const cache = join(dir, ".evalo", "cache.db");
  if (!existsSync(cache)) {
    throw new Response(
      `Evalo "${ownerSlug}/${evaloSlug}" has no index. Run \`evalo reindex --root ${dir}\` first.`,
      { status: 404 },
    );
  }
  return new BetterSqlite3(cache, { readonly: true, fileMustExist: true });
}

/** Read evalo.yaml.slug from the Evalo's source files (no db needed). */
export function readEvaloFullSlug(ownerSlug: string, evaloSlug: string): string {
  return `${ownerSlug}/${evaloSlug}`;
}
