import { getDocoByHandle } from "@doco/db";

export function recordDocoSlugAlias(
  _fromOwner: string,
  _fromSlug: string,
  _toOwner: string,
  _toSlug: string,
  _docoId: string,
): void {
  // No alias persistence in alpha. Renames update the canonical
  // Postgres row directly. After slug-removal phase 3 the only
  // identifier that can be renamed is `handle`; the legacy
  // `(owner_slug, doco_slug)` pair no longer exists in storage so
  // there's nothing to alias from.
}

/** Resolve a Doco by its `handle` (public, globally-unique URL id). */
export async function resolveDocoHandleAlias(
  handle: string,
): Promise<{ handle: string; ownerSlug: string; docoSlug: string } | null> {
  const row = await getDocoByHandle(handle);
  return row
    ? { handle: row.handle, ownerSlug: row.owner_slug, docoSlug: row.doco_slug }
    : null;
}
