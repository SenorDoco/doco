// Host-root path helpers. Durable storage is Postgres; nothing the web
// app reads or writes lives on disk. `docoPath` only builds a stable
// placeholder path for APIs that still accept a root-shaped argument.
//
// Also a small re-export surface for `@doco/db` helpers that route
// files use from their loader/action — going through this `.server.ts`
// re-export keeps the `@doco/db` import out of the client bundle (the
// barrel re-exports the Postgres pool, which Vite can't bundle for the
// browser).

import { join } from "node:path";

export { getDocoById } from "@doco/db";

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
