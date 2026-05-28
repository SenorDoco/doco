import { listPrincipals } from "@doco/db";

/**
 * Resolve an authenticated user to a Principal NEURON id in a
 * Doco. Principal fields reference principals.id; user ids stay
 * in provenance fields such as created_by and audit_events.by_user.
 */
const principalForUserCache = new Map<string, string>();

export async function resolvePrincipalIdForUser(
  docoId: string,
  userId: string,
): Promise<string | null> {
  const key = `${docoId}:${userId}`;
  const cached = principalForUserCache.get(key);
  if (cached) return cached;
  const rows = await listPrincipals(docoId);
  const own = rows.find((r) => {
    const data = r.data ?? {};
    return (
      (typeof data.created_by === "string" && data.created_by === userId) ||
      (typeof data.owner_id === "string" && data.owner_id === userId)
    );
  });
  const role = rows.find((r) => r.name === "user") ?? rows.find((r) => r.name === "human") ?? null;
  const pick = own ?? role;
  if (!pick) return null;
  principalForUserCache.set(key, pick.id);
  return pick.id;
}
