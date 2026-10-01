// The query log: one `query_events` row per query, the read-side twin of a
// write's changeset. It records who queried, where (a Doco, or a whole
// workspace for a workspace search), and how they came in, using the same
// request context a changeset records (`authoringContextForRequest`), so
// `agentName` names the agent the same way for reads and writes.
//
// A query is every agent read of a Doco (the read gate in doco-access.server
// records those) and every search on the website (the search pages record
// those). Opening a page on the website isn't a query.

import { withClient } from "@doco/db";
import { authoringContextForRequest } from "./authoring-source.server";

export interface QueryScope {
  workspaceId: string;
  /** Null for a search across the whole workspace. */
  docoId: string | null;
}

/** Record one query. Never throws: a missing log row must not fail the read,
 *  so callers hand the promise to `waitUntil` and move on. */
export async function recordQuery(
  request: Request,
  scope: QueryScope,
  actorId: string | null,
): Promise<void> {
  try {
    const { source, metadata } = await authoringContextForRequest(request);
    await withClient((c) =>
      c.query(
        `INSERT INTO query_events (actor, workspace_id, doco_id, source, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          actorId,
          scope.workspaceId,
          scope.docoId,
          source,
          metadata ? JSON.stringify(metadata) : null,
        ],
      ),
    );
  } catch (err) {
    console.error("query-log: insert failed", (err as Error).message);
  }
}
