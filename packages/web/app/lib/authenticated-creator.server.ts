const CLIENT_PROVENANCE_KEYS = [
  "created_by",
  "created_by_collaborator_id",
  "created_by_principal_id",
  "updated_by",
  "updated_by_collaborator_id",
  "updated_by_principal_id",
] as const;

export function stampAuthenticatedCreator<TDraft extends object>(
  draft: TDraft,
  collaboratorId: string | null | undefined,
): TDraft {
  const mutable = draft as Record<string, unknown>;
  for (const key of CLIENT_PROVENANCE_KEYS) {
    delete mutable[key];
  }
  if (collaboratorId) {
    mutable.created_by_collaborator_id = collaboratorId;
  }
  return draft;
}
