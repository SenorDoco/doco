// Per-Doco aggregate stats (Nodes, Active nodes, Edges, Last updated)
// shown on the dashboard and owner-profile docos tables.
//
// `nodes` counts domain nodes: decisions, intents, rules,
// actions, evals, ideas, reference_entities, logs, states, and the
// Doco's principals. Policies are not nodes and are deliberately
// excluded — they are surfaced via /<handle>/api/policies.json.
// `edges` reads the materialized `edges` table.
// `lastUpdatedAt` prefers the max `at` from `audit_events`, and falls
// back to entity `updated_at` for imported/pre-audit Docos.

import { withClient } from "@doco/db";

export interface DocoStats {
  nodes: number;
  activeNodes: number;
  edges: number;
  lastUpdatedAt: string | null;
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
// Exported so the org-tree / org-index aggregate queries can build the
// same `FROM nodes WHERE node_type IN (...)` union without duplicating
// the list.
export const NODE_TYPES_FOR_STATS_SQL = NODE_TYPES_FOR_STATS.map((t) => `'${t}'`).join(", ");

const EMPTY: DocoStats = { nodes: 0, activeNodes: 0, edges: 0, lastUpdatedAt: null };

export async function listDocoStats(docoIds: readonly string[]): Promise<Map<string, DocoStats>> {
  const out = new Map<string, DocoStats>();
  if (docoIds.length === 0) return out;
  const ids = [...docoIds];

  return withClient(async (c) => {
    const nodesSql = `SELECT doco_id, lifecycle, updated_at
         FROM nodes
        WHERE doco_id = ANY($1)
          AND node_type IN (${NODE_TYPES_FOR_STATS_SQL})`;
    const [nodesRows, edgesRows, updatedRows] = await Promise.all([
      c.query<{ doco_id: string; n: string; active_n: string; last_entity_at: string | null }>(
        `SELECT doco_id,
                COUNT(*)::text AS n,
                COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'asserted') = 'asserted')::text AS active_n,
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
    ]);

    for (const id of ids) out.set(id, { ...EMPTY });
    for (const r of nodesRows.rows) {
      const s = out.get(r.doco_id);
      if (s) {
        s.nodes = Number(r.n);
        s.activeNodes = Number(r.active_n);
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
    return out;
  });
}

function newestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
