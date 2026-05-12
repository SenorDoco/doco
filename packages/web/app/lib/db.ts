import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let cachedRoot: string | null = null;

/**
 * Find the Doco root: DOCO_ROOT env var first (must contain doco.yaml),
 * otherwise walk upward from cwd looking for the marker. Per ADR-087
 * (local-solo collapse), host mode is gone — single Doco at root is the
 * only shape.
 */
export function rootDir(): string {
  if (cachedRoot) return cachedRoot;
  const fromEnv = process.env.DOCO_ROOT;
  if (fromEnv && existsSync(join(fromEnv, "doco.yaml"))) {
    cachedRoot = resolve(fromEnv);
    return cachedRoot;
  }
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "doco.yaml"))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not find doco.yaml. Set DOCO_ROOT or run from inside a Doco.",
  );
}

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
