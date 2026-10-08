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

/** What `formatAuthoringMechanism` calls a write or read made on the website
 *  itself, by a person rather than an agent. */
const WEBSITE = "Website";

/** What `formatAuthoringMechanism` calls a write no request recorded: one an
 *  integration's import made, not a person or their agent. */
export const IMPORT = "Import";

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
  if (surface === "website") return WEBSITE;
  if (surface === "slack" || source === "slack") return "Slack";
  if (surface === "mcp" || source === "mcp") return "MCP";
  if (source === "ui") return WEBSITE;
  if (source === "api" && tokenName) return tokenName;
  if (source === "api" && auth) return "API";
  // Every request records how it arrived (an auth or a surface), so a write
  // with neither came from Doco itself, such as the GitHub import.
  if (source === "api") return IMPORT;
  if (source === "import") return IMPORT;
  if (source === "reset") return "Reset";
  if (source === "system") return "System";
  return source ? source.replaceAll("_", " ") : null;
}

/** SQL for the part of a changesets or query_events row's metadata (`t`)
 *  that `formatAuthoringMechanism` reads, to group rows by how they arrived:
 *  grouped whole, a brief's query, which records its id and timings, would be
 *  a group of its own. */
export function mechanismMetadataSql(t: string): string {
  const keys = ["surface", "client", "auth", "token_name", "client_name"];
  return `jsonb_build_object(${keys.map((k) => `'${k}', ${t}.metadata->'${k}'`).join(", ")})`;
}

/** SQL that holds when a read or write (`t`, a changesets or query_events
 *  row) came from an agent over the MCP server or the API: a request with a
 *  credential. An API write with none came from Doco itself, as above, so
 *  Doco's own imports never count. */
export function byAgentOverApiSql(t: string): string {
  return `(${t}.source = 'mcp' OR (${t}.source = 'api' AND ${t}.metadata ? 'auth'))`;
}

/** The agent a person wrote or queried through, or null when they used the
 *  website themselves. Señor Doco counts as an agent, on the website too. */
export function agentName(
  source: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const mechanism = formatAuthoringMechanism(source, metadata);
  return mechanism === WEBSITE ? null : mechanism;
}

/** How a top list names the way a person worked: "via <agent>", or "on the
 *  website" (`via` null). */
export function viaLabel(via: string | null): string {
  return via ? `via ${via}` : "on the website";
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
