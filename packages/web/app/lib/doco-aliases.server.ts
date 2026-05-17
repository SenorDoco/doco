import { getDocoBySlug, getDocoByHandle } from "@doco/db";

export interface DocoSlugResolution {
  ownerSlug: string;
  docoSlug: string;
  redirected: boolean;
}

export async function resolveDocoSlugAlias(
  ownerSlug: string,
  docoSlug: string,
): Promise<DocoSlugResolution | null> {
  const row = await getDocoBySlug(ownerSlug, docoSlug);
  return row ? { ownerSlug, docoSlug, redirected: false } : null;
}

export function recordDocoSlugAlias(
  _fromOwner: string,
  _fromSlug: string,
  _toOwner: string,
  _toSlug: string,
  _docoId: string,
): void {
  // No alias persistence in alpha. Renames update the canonical Postgres row.
}

/**
 * Phase 1 of slug-removal: resolve a Doco by its `handle` (public,
 * globally-unique URL id). Routes that switch to the new `/<doco-id>/`
 * shape use this instead of `resolveDocoSlugAlias`.
 */
export async function resolveDocoHandleAlias(
  handle: string,
): Promise<{ handle: string; ownerSlug: string; docoSlug: string } | null> {
  const row = await getDocoByHandle(handle);
  return row
    ? { handle: row.handle, ownerSlug: row.owner_slug, docoSlug: row.doco_slug }
    : null;
}
