import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let cachedRoot: string | null = null;

/**
 * Find the Evalo root: env var first, otherwise walk upward from cwd looking
 * for evalo.yaml.
 */
export function evaloRoot(): string {
  if (cachedRoot) return cachedRoot;
  const fromEnv = process.env.EVALO_ROOT;
  if (fromEnv && existsSync(join(fromEnv, "evalo.yaml"))) {
    cachedRoot = resolve(fromEnv);
    return cachedRoot;
  }
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "evalo.yaml"))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not find evalo.yaml. Set EVALO_ROOT or run `react-router dev` from inside an Evalo.",
  );
}

export function openDb(): Database {
  const root = evaloRoot();
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
