// Per-Doco aggregate stats (Nodes, per-lifecycle counts, Edges, Last
// updated) shown in each workspace page's Doco list.
//
// `nodes` counts domain nodes: decisions, intents, rules,
// actions, evals, ideas, reference_entities, logs, states, and the
// Doco's principals. Policies are not nodes and are deliberately
// excluded — they are surfaced via /<handle>/api/policies.json.
// `counts` is that same total split by lifecycle stage
// (drafting / queued / active / retired) for the colored count display.
// `edges` reads the persisted `edges` table.
// `copied` counts what a Doco copied from its source (code files, Slack
// messages, Notion pages), which are not nodes.
// `lastUpdatedAt` is the newest of the max `at` from `audit_events`,
// entity `updated_at` (imported/pre-audit Docos) and the latest copy.

import { withClient } from "@doco/db";
import { EMPTY_LIFECYCLE_COUNTS, type LifecycleCounts } from "./node-colors";

/** What a Doco copied from its source, and the noun one copy goes by. */
export interface Copied {
  count: number;
  unit: "file" | "message" | "page";
}

export interface DocoStats {
  nodes: number;
  counts: LifecycleCounts;
  edges: number;
  copied: Copied | null;
  lastUpdatedAt: string | null;
}

/** Every copy a Doco holds of its source, as (doco_id, unit, at) rows: the
 *  files of a codebase, the messages of the Slack channels it copies, and the
 *  Notion pages fetched so far. `at` is when it happened in the source where
 *  the source says (a message posted, a page last edited; null when Notion
 *  gave no time), else when Doco copied it (a code file). */
export const COPIED_ITEMS_SQL = `
  SELECT doco_id, 'file' AS unit, synced_at AS at FROM code_files
  UNION ALL
  SELECT m.doco_id, 'message', m.posted_at
    FROM group_chat_messages m
    JOIN group_chat_channels ch USING (doco_id, channel_id)
   WHERE NOT ch.excluded
  UNION ALL
  SELECT doco_id, 'page', last_edited_time FROM notion_pages WHERE synced_at IS NOT NULL`;

type QueryClient = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

/** How many copies of these Docos happened each day since `since`, keyed by
 *  YYYY-MM-DD, for the activity charts. */
export async function copiesByDay(
  c: QueryClient,
  docoIds: readonly string[],
  since: string,
): Promise<Record<string, number>> {
  const rows = (
    await c.query<{ day: string; n: string }>(
      `SELECT to_char(at, 'YYYY-MM-DD') AS day, COUNT(*)::text AS n
         FROM (${COPIED_ITEMS_SQL}) copied
        WHERE doco_id = ANY($1::text[]) AND at >= $2
        GROUP BY day`,
      [[...docoIds], since],
    )
  ).rows;
  return Object.fromEntries(rows.map((r) => [r.day, Number(r.n)]));
}

// Post-collapse: every node lives in the unified `nodes` table,
// discriminated by `node_type`. Stats count domain nodes plus the
// Doco's principals. Policies are deliberately excluded (their own
// surface). This list is the set of `node_type` values that count as
// "nodes" for the stats/aggregate queries.
export const NODE_TYPES_FOR_STATS = [
  "decision",
  "intent",
  "rule",
  "action",
  "eval",
  "idea",
  "reference",
  "log",
  "state",
  "principal",
] as const;

// SQL fragment listing the stats node types, e.g. "'decision', 'intent', …".
// Exported so the org-tree / workspace-index aggregate queries can build the
// same `FROM nodes WHERE node_type IN (...)` union without duplicating
// the list.
export const NODE_TYPES_FOR_STATS_SQL = NODE_TYPES_FOR_STATS.map((t) => `'${t}'`).join(", ");

export const EMPTY_DOCO_STATS: DocoStats = {
  nodes: 0,
  counts: EMPTY_LIFECYCLE_COUNTS,
  edges: 0,
  copied: null,
  lastUpdatedAt: null,
};

export async function listDocoStats(docoIds: readonly string[]): Promise<Map<string, DocoStats>> {
  const out = new Map<string, DocoStats>();
  if (docoIds.length === 0) return out;
  const ids = [...docoIds];

  return withClient(async (c) => {
    const nodesSql = `SELECT doco_id, lifecycle, updated_at
         FROM nodes
        WHERE doco_id = ANY($1)
          AND node_type IN (${NODE_TYPES_FOR_STATS_SQL})`;
    const [nodesRows, edgesRows, updatedRows, copiedRows] = await Promise.all([
      c.query<{
        doco_id: string;
        n: string;
        drafting_n: string;
        queued_n: string;
        active_n: string;
        retired_n: string;
        last_entity_at: string | null;
      }>(
        `SELECT doco_id,
                COUNT(*)::text AS n,
                COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'drafting')::text AS drafting_n,
                COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'queued')::text AS queued_n,
                COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'active')::text AS active_n,
                COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'retired')::text AS retired_n,
                MAX(updated_at)::text AS last_entity_at
           FROM (${nodesSql}) t
          GROUP BY doco_id`,
        [ids],
      ),
      c.query<{ doco_id: string; n: string }>(
        "SELECT doco_id, COUNT(*)::text AS n FROM edges WHERE doco_id = ANY($1) GROUP BY doco_id",
        [ids],
      ),
      c.query<{ doco_id: string; last_at: string }>(
        "SELECT doco_id, MAX(at)::text AS last_at FROM audit_events WHERE doco_id = ANY($1) GROUP BY doco_id",
        [ids],
      ),
      c.query<{ doco_id: string; unit: Copied["unit"]; n: string; last_at: string }>(
        `SELECT doco_id, unit, COUNT(*)::text AS n, MAX(at)::text AS last_at
           FROM (${COPIED_ITEMS_SQL}) t
          WHERE doco_id = ANY($1)
          GROUP BY doco_id, unit`,
        [ids],
      ),
    ]);

    for (const id of ids)
      out.set(id, { ...EMPTY_DOCO_STATS, counts: { ...EMPTY_LIFECYCLE_COUNTS } });
    for (const r of nodesRows.rows) {
      const s = out.get(r.doco_id);
      if (s) {
        s.nodes = Number(r.n);
        s.counts = {
          drafting: Number(r.drafting_n),
          queued: Number(r.queued_n),
          active: Number(r.active_n),
          retired: Number(r.retired_n),
        };
        s.lastUpdatedAt = newestIso(s.lastUpdatedAt, r.last_entity_at);
      }
    }
    for (const r of edgesRows.rows) {
      const s = out.get(r.doco_id);
      if (s) s.edges = Number(r.n);
    }
    for (const r of updatedRows.rows) {
      const s = out.get(r.doco_id);
      if (s) s.lastUpdatedAt = newestIso(s.lastUpdatedAt, r.last_at);
    }
    for (const r of copiedRows.rows) {
      const s = out.get(r.doco_id);
      if (s) {
        s.copied = { count: Number(r.n), unit: r.unit };
        s.lastUpdatedAt = newestIso(s.lastUpdatedAt, r.last_at);
      }
    }
    return out;
  });
}

function newestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
