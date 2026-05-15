// Host-root path helpers. Durable storage is Postgres; nothing the web
// app reads or writes lives on disk. `docoPath` only builds a stable
// placeholder path for APIs that still accept a root-shaped argument.

import { join } from "node:path";

let cachedRoot: string | null = null;

/**
 * Resolve the host root placeholder. Canonical reads and writes go
 * through Postgres, so this must not discover or depend on a local
 * `docos/` tree.
 */
export function rootDir(): string {
  cachedRoot ??= process.cwd();
  return cachedRoot;
}

export function docoPath(ownerSlug: string, docoSlug: string): string {
  return join(rootDir(), "docos", ownerSlug, docoSlug);
}

export function readDocoFullSlug(ownerSlug: string, docoSlug: string): string {
  return `${ownerSlug}/${docoSlug}`;
}
