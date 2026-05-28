import { listPrincipals } from "@doco/db";

/**
 * Resolve an authenticated collaborator to a Principal NEURON id in a
 * Doco. Principal fields reference principals.id; collaborator ids stay
 * in provenance fields such as created_by and audit_events.by_collaborator.
 */
const principalForCollaboratorCache = new Map<string, string>();

export async function resolvePrincipalIdForCollaborator(
  docoId: string,
  collaboratorId: string,
): Promise<string | null> {
  const key = `${docoId}:${collaboratorId}`;
  const cached = principalForCollaboratorCache.get(key);
  if (cached) return cached;
  const rows = await listPrincipals(docoId);
  const own = rows.find((r) => {
    const data = r.data ?? {};
    return (
      (typeof data.created_by === "string" && data.created_by === collaboratorId) ||
      (typeof data.owner_id === "string" && data.owner_id === collaboratorId)
    );
  });
  const role = rows.find((r) => r.name === "user") ?? rows.find((r) => r.name === "human") ?? null;
  const pick = own ?? role;
  if (!pick) return null;
  principalForCollaboratorCache.set(key, pick.id);
  return pick.id;
}
