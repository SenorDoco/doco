// Host-root path helpers. Durable storage is Postgres; nothing the web
// app reads or writes lives on disk. `docoPath` only builds a stable
// placeholder path for APIs that still accept a root-shaped argument.

import { join } from "node:path";

let cachedRoot: string | null = null;

export function rootDir(): string {
  cachedRoot ??= process.cwd();
  return cachedRoot;
}

export function docoPath(ownerSlug: string, docoSlug: string): string {
  return join(rootDir(), "docos", ownerSlug, docoSlug);
}

/**
 * Phase-2 path builder for handle-keyed lookups. Once routes drop the
 * owner prefix, this replaces `docoPath`. For now both shapes exist so
 * callers can migrate at their own pace.
 */
export function docoPathByHandle(handle: string): string {
  return join(rootDir(), "docos", handle);
}

export function readDocoFullSlug(ownerSlug: string, docoSlug: string): string {
  return `${ownerSlug}/${docoSlug}`;
}
