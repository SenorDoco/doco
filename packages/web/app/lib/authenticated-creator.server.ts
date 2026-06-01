const CLIENT_PROVENANCE_KEYS = [
  "created_by",
  "created_by_user_id",
  "updated_by",
  "updated_by_user_id",
] as const;

export function stampAuthenticatedCreator<TDraft extends object>(
  draft: TDraft,
  userId: string | null | undefined,
): TDraft {
  const mutable = draft as Record<string, unknown>;
  for (const key of CLIENT_PROVENANCE_KEYS) {
    delete mutable[key];
  }
  if (userId) {
    mutable.created_by_user_id = userId;
  }
  return draft;
}
