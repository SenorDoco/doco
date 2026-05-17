import { getDocoByHandle } from "@doco/db";

/** Resolve a Doco by its `handle` (public, globally-unique URL id). */
export async function resolveDocoHandleAlias(
  handle: string,
): Promise<{ handle: string; ownerUsername: string } | null> {
  const row = await getDocoByHandle(handle);
  return row ? { handle: row.handle, ownerUsername: row.owner_slug } : null;
}
