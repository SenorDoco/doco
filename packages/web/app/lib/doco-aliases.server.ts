import { getDocoBySlug } from "@doco/db";

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
