// How a workspace connects each source of knowledge besides GitHub in one
// click from its onboarding: whether this host can connect it at all, the
// authorization that turns the source's Doco into a kept copy (coming back to
// `next` once it's on), and whether a Doco copies from it yet. One connector
// per catalog integration with a `template` (KNOWLEDGE_SOURCE_INTEGRATIONS), so
// a new source joins the onboarding by adding its catalog entry and its
// connector here; a test holds the two together.
import { getNotionConfig } from "./notion-api.server";
import { buildNotionAuthorizeUrl } from "./notion-mirror-setup.server";
import { buildSlackInstallUrl, getSlackConfig } from "./slack.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface KnowledgeSourceConnector {
  /** Whether this host has the source's app credentials. */
  configured(): boolean;
  /** Where the person approves the copy, or null when the host can't. */
  authorizeUrl(
    request: Request,
    args: { docoId: string; workspaceId: string; userId: string; next: string },
  ): string | null;
  /** True when Doco $1 copies from the source. */
  connectedSql: string;
}

export const KNOWLEDGE_SOURCE_CONNECTORS: Record<string, KnowledgeSourceConnector> = {
  slack: {
    configured: () => getSlackConfig().configured,
    authorizeUrl: (request, { docoId, workspaceId, userId, next }) =>
      buildSlackInstallUrl(request, userId, workspaceId, { mirrorDocoId: docoId, next }),
    connectedSql:
      "SELECT EXISTS (SELECT 1 FROM group_chat_mirrors WHERE doco_id = $1) AS connected",
  },
  notion: {
    configured: () => getNotionConfig().configured,
    authorizeUrl: (request, args) => buildNotionAuthorizeUrl(request, args),
    connectedSql: "SELECT EXISTS (SELECT 1 FROM notion_mirrors WHERE doco_id = $1) AS connected",
  },
};

/** Whether the Doco copies from the source connected by `integrationId`. */
export async function sourceConnected(
  c: QueryClient,
  integrationId: string,
  docoId: string,
): Promise<boolean> {
  const connector = KNOWLEDGE_SOURCE_CONNECTORS[integrationId];
  if (!connector) return false;
  const { rows } = await c.query<{ connected: boolean }>(connector.connectedSql, [docoId]);
  return Boolean(rows[0]?.connected);
}
