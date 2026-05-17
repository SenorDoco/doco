// Host-root path helpers. Durable storage is Postgres; nothing the web
// app reads or writes lives on disk. `docoPath` only builds a stable
// placeholder path for APIs that still accept a root-shaped argument.

import { join } from "node:path";

let cachedRoot: string | null = null;

export function rootDir(): string {
  cachedRoot ??= process.cwd();
  return cachedRoot;
}

/**
 * Stable placeholder path for capture / reindex APIs that still take a
 * `docoDir` argument. The path is never read from disk — Postgres is
 * the source of truth — but downstream helpers parse `basename(docoDir)`
 * to recover the handle, so we encode the canonical handle directly
 * here. Use `docoPath(handle)` everywhere.
 */
export function docoPath(handle: string): string {
  return join(rootDir(), "docos", handle);
}
