// Server-only Doco metadata helper. Reads a Doco's row from Postgres
// + reads its `data` jsonb so route loaders can render display name /
// visibility without each one doing its own SELECT.
import { basename } from "node:path";
import { getDocoByHandle } from "@doco/db";

export interface DocoMetadata {
  docoId: string;
  /** Public globally-unique URL identifier. */
  handle: string;
  ownerId: string;
  displayName: string;
  visibility: "private" | "public";
  /**
   * Project-owner-authored sentence (or template-seeded default)
   * describing what this Doco is for. Surfaced under the title on
   * the Doco home page and at the top of each Doco's primitive set
   * in the agent-bootstrap manifest. Empty string when unset.
   */
  goalDescription: string;
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
  let displayName = row.name ?? "";
  if (!displayName && typeof row.data.display_name === "string") {
    displayName = row.data.display_name;
  }
  return {
    docoId: row.id,
    handle: row.handle,
    ownerId: row.owner_id,
    displayName,
    visibility: row.visibility,
    goalDescription: row.goal_description,
  };
}
