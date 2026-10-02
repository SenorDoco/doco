// Per-Doco stats shown in each workspace page's Doco list: how many of the
// one thing it holds the Doco has (`items`, named by its template's item; see
// docoItemFor), and when it last changed.
//
// What counts as one item comes from the Doco's template: its nodes of one
// type, any of its nodes (policies are not nodes; they are surfaced via
// /<handle>/api/policies.json), what it imported from its source (code files,
// Slack messages, Notion pages, which are not nodes), or its processes.
// `lastUpdatedAt` is the newest of the max `at` from `audit_events`, node
// `updated_at` (imported/pre-audit Docos) and the latest import.

import { withClient } from "@doco/db";
import { IMPORTED_ITEMS_SQL } from "./activity-log.server";
import { docoItemFor } from "./doco-templates-meta";

export interface DocoStats {
  items: number;
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
// Exported so the org-tree / workspace-index aggregate queries can build the
// same `FROM nodes WHERE node_type IN (...)` union without duplicating
// the list.
export const NODE_TYPES_FOR_STATS_SQL = NODE_TYPES_FOR_STATS.map((t) => `'${t}'`).join(", ");

export const EMPTY_DOCO_STATS: DocoStats = { items: 0, lastUpdatedAt: null };

export async function listDocoStats(docoIds: readonly string[]): Promise<Map<string, DocoStats>> {
  const out = new Map<string, DocoStats>();
  if (docoIds.length === 0) return out;
  const ids = [...docoIds];

  return withClient(async (c) => {
    const [docoRows, nodeRows, processRows, auditRows, importedRows] = await Promise.all([
      c.query<{ id: string; template: string | null }>(
        "SELECT id, data->>'template_handle' AS template FROM docos WHERE id = ANY($1)",
        [ids],
      ),
      c.query<{ doco_id: string; node_type: string; n: string; last_at: string }>(
        `SELECT doco_id, node_type, COUNT(*)::text AS n, MAX(updated_at)::text AS last_at
           FROM nodes
          WHERE doco_id = ANY($1)
            AND node_type IN (${NODE_TYPES_FOR_STATS_SQL})
          GROUP BY doco_id, node_type`,
        [ids],
      ),
      // A process is an Action with child Actions linked to it by `has_parent`
      // (see process-perspective.server.ts).
      c.query<{ doco_id: string; n: string }>(
        `SELECT doco_id, COUNT(DISTINCT to_id)::text AS n
           FROM edges
          WHERE doco_id = ANY($1)
            AND edge_type = 'has_parent'
            AND from_node_type = 'action'
            AND to_node_type = 'action'
          GROUP BY doco_id`,
        [ids],
      ),
      c.query<{ doco_id: string; last_at: string }>(
        "SELECT doco_id, MAX(at)::text AS last_at FROM audit_events WHERE doco_id = ANY($1) GROUP BY doco_id",
        [ids],
      ),
      c.query<{ doco_id: string; n: string; last_at: string | null }>(
        `SELECT doco_id, COUNT(*)::text AS n, MAX(at)::text AS last_at
           FROM (${IMPORTED_ITEMS_SQL}) t
          WHERE doco_id = ANY($1)
          GROUP BY doco_id`,
        [ids],
      ),
    ]);

    const counts = (rows: { doco_id: string; n: string }[]) =>
      new Map(rows.map((r) => [r.doco_id, Number(r.n)]));
    const processes = counts(processRows.rows);
    const imports = counts(importedRows.rows);
    const items = (id: string, template: string | null): number => {
      const { counts: what } = docoItemFor(template);
      if (what === "process") return processes.get(id) ?? 0;
      if (what === "import") return imports.get(id) ?? 0;
      return nodeRows.rows
        .filter((r) => r.doco_id === id && (what === "node" || r.node_type === what))
        .reduce((sum, r) => sum + Number(r.n), 0);
    };

    for (const id of ids) out.set(id, { ...EMPTY_DOCO_STATS });
    for (const r of docoRows.rows) {
      const s = out.get(r.id);
      if (s) s.items = items(r.id, r.template);
    }
    for (const r of [...nodeRows.rows, ...auditRows.rows, ...importedRows.rows]) {
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
