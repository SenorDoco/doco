// Server-only Doco metadata helper. Reads a Doco's row from Postgres
// + parses its raw_yaml so route loaders can render description /
// display name / visibility without each one doing its own SELECT.
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
