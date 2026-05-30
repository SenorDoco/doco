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

const STATS_ENTITY_TABLE_SPECS = [
  { table: "decisions", docoIdSql: "doco_id", docoWhereSql: "doco_id = ANY($1)" },
  { table: "intents", docoIdSql: "doco_id", docoWhereSql: "doco_id = ANY($1)" },
  { table: "rules", docoIdSql: "doco_id", docoWhereSql: "doco_id = ANY($1)" },
  { table: "actions", docoIdSql: "doco_id", docoWhereSql: "doco_id = ANY($1)" },
  { table: "evals", docoIdSql: "doco_id", docoWhereSql: "doco_id = ANY($1)" },
  { table: "ideas", docoIdSql: "doco_id", docoWhereSql: "doco_id = ANY($1)" },
  { table: "reference_entities", docoIdSql: "doco_id", docoWhereSql: "doco_id = ANY($1)" },
  { table: "logs", docoIdSql: "doco_id", docoWhereSql: "doco_id = ANY($1)" },
  { table: "states", docoIdSql: "doco_id", docoWhereSql: "doco_id = ANY($1)" },
  { table: "principals", docoIdSql: "doco_id", docoWhereSql: "doco_id = ANY($1)" },
];

export const ENTITY_TABLES = STATS_ENTITY_TABLE_SPECS.map((spec) => spec.table);

const EMPTY: DocoStats = { nodes: 0, activeNodes: 0, edges: 0, lastUpdatedAt: null };

export async function listDocoStats(docoIds: readonly string[]): Promise<Map<string, DocoStats>> {
  const out = new Map<string, DocoStats>();
  if (docoIds.length === 0) return out;
  const ids = [...docoIds];

  return withClient(async (c) => {
    const nodesSql = STATS_ENTITY_TABLE_SPECS.map(
      (spec) =>
        `SELECT ${spec.docoIdSql} AS doco_id, lifecycle, updated_at FROM ${spec.table} WHERE ${spec.docoWhereSql}`,
    ).join(" UNION ALL ");
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
