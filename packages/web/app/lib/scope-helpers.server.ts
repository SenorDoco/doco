// Server-only Doco metadata helper. The file kept the legacy
// "scope-helpers" name because half the consumers still import it
// here; that's a follow-on rename. Today every active helper here is
// about the Doco itself, not scopes.
import { basename } from "node:path";
import { getDocoByHandle } from "@doco/db";
import { parse as parseYaml } from "yaml";

export interface DocoMetadata {
  docoId: string;
  /** Public globally-unique URL identifier. */
  handle: string;
  ownerId: string;
  displayName: string;
  description: string;
  visibility: "private" | "public";
}

/**
 * Read a Doco's metadata from Postgres. `docoDir` is a placeholder
 * built by `docoPath(handle)` — its basename is the handle. Lookup
 * keys off `handle` directly.
 */
export async function readDocoMetadata(docoDir: string): Promise<DocoMetadata | null> {
  const handle = basename(docoDir);
  if (!handle) return null;
  const row = await getDocoByHandle(handle);
  if (!row) return null;
  let description = "";
  let displayName = row.name ?? "";
  try {
    const parsed = parseYaml(row.raw_yaml) as Record<string, unknown>;
    if (typeof parsed.description === "string") description = parsed.description;
    if (!displayName && typeof parsed.display_name === "string") {
      displayName = parsed.display_name;
    }
  } catch {
    // raw_yaml unparseable — fall back to row.name and empty description.
  }
  return {
    docoId: row.id,
    handle: row.handle,
    ownerId: row.owner_id,
    displayName,
    description,
    visibility: row.visibility,
  };
}

/**
 * v16: scopes are gone; this used to enrich capture footer prose with
 * scope-name + icon pairs. Kept as a no-op stub so the many
 * capture.server.ts callers don't fan out a refactor in the same
 * commit. Always resolves to [] — the footer-line builder treats an
 * empty list as "no scope tail".
 *
 * Removed once the capture pipeline drops its `scopes` field entirely
 * (commit H of the v16 cleanup sweep).
 */
export async function resolveScopeIcons(
  _docoDir: string,
  _scopeIds: readonly string[],
): Promise<{ name: string; icon?: string }[]> {
  return [];
}
