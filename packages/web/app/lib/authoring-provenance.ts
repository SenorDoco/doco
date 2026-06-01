export interface AuthoringActorEntry {
  user_id: string | null;
  user_label: string | null;
  mechanism: string | null;
  source: string | null;
  at: string | null;
}

export interface AuthoringPair {
  created: AuthoringActorEntry | null;
  updated: AuthoringActorEntry | null;
}

export function formatAuthoringMechanism(
  source: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const surface = typeof metadata?.surface === "string" ? metadata.surface : null;
  const client = typeof metadata?.client === "string" ? metadata.client : null;
  const auth = typeof metadata?.auth === "string" ? metadata.auth : null;
  const tokenName =
    typeof metadata?.token_name === "string" && metadata.token_name.trim()
      ? metadata.token_name.trim()
      : typeof metadata?.client_name === "string" && metadata.client_name.trim()
        ? metadata.client_name.trim()
        : null;

  if (surface === "senor_doco" && client === "website") return "Señor Doco on website";
  if (surface === "website") return "Website";
  if (surface === "slack" || source === "slack") return "Slack";
  if (surface === "mcp" || source === "mcp") return "MCP";
  if (source === "ui") return "Website";
  if (source === "api" && tokenName) return tokenName;
  if (source === "api" && auth === "oauth") return "API";
  if (source === "api") return "API";
  if (source === "import") return "Import";
  if (source === "reset") return "Reset";
  if (source === "system") return "System";
  return source ? source.replaceAll("_", " ") : null;
}

export function authoringEntry(input: {
  actor: string | null | undefined;
  labels: Map<string, string>;
  source: string | null | undefined;
  metadata: Record<string, unknown> | null | undefined;
  at: string | null | undefined;
}): AuthoringActorEntry | null {
  const userId = input.actor ?? null;
  const mechanism = formatAuthoringMechanism(input.source, input.metadata);
  const at = input.at ?? null;
  if (!userId && !mechanism && !at) return null;
  return {
    user_id: userId,
    user_label: userId ? (input.labels.get(userId) ?? null) : null,
    mechanism,
    source: input.source ?? null,
    at,
  };
}
