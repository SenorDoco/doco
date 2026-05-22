// Per-Doco aggregate stats (Neurons, Synapses, Last updated) shown on the
// dashboard and owner-profile docos tables.
//
// Nodes counts only domain entities: decisions, intents, rules,
// actions, evals, ideas, reference_entities, logs, states. Articles
// (constitution metadata) are not nodes and are deliberately
// excluded — they are surfaced via /<handle>/api/articles.json.
// Synapses reads the materialized `synapses` table.
// Last updated is the max `at` from `audit_events` — that captures both
// inserts and updates and is cheap because audit_events is already
// indexed by doco_id.

import { withClient } from "@doco/db";

export interface DocoStats {
  nodes: number;
  synapses: number;
  lastUpdatedAt: string | null;
}

export const ENTITY_TABLES = [
  "decisions",
  "intents",
  "rules",
  "actions",
  "evals",
  "ideas",
  "reference_entities",
  "logs",
  // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): State node type.
  "states",
] as const;

const EMPTY: DocoStats = { nodes: 0, synapses: 0, lastUpdatedAt: null };

export async function listDocoStats(docoIds: readonly string[]): Promise<Map<string, DocoStats>> {
  const out = new Map<string, DocoStats>();
  if (docoIds.length === 0) return out;
  const ids = [...docoIds];

  return withClient(async (c) => {
    const nodesSql = ENTITY_TABLES.map(
      (t) => `SELECT doco_id FROM ${t} WHERE doco_id = ANY($1)`,
    ).join(" UNION ALL ");
    const [nodesRows, edgesRows, updatedRows] = await Promise.all([
      c.query<{ doco_id: string; n: string }>(
        `SELECT doco_id, COUNT(*)::text AS n FROM (${nodesSql}) t GROUP BY doco_id`,
        [ids],
      ),
      c.query<{ doco_id: string; n: string }>(
        `SELECT doco_id, COUNT(*)::text AS n FROM synapses WHERE doco_id = ANY($1) GROUP BY doco_id`,
        [ids],
      ),
      c.query<{ doco_id: string; last_at: string }>(
        `SELECT doco_id, MAX(at)::text AS last_at FROM audit_events WHERE doco_id = ANY($1) GROUP BY doco_id`,
        [ids],
      ),
    ]);

    for (const id of ids) out.set(id, { ...EMPTY });
    for (const r of nodesRows.rows) {
      const s = out.get(r.doco_id);
      if (s) s.nodes = Number(r.n);
    }
    for (const r of edgesRows.rows) {
      const s = out.get(r.doco_id);
      if (s) s.synapses = Number(r.n);
    }
    for (const r of updatedRows.rows) {
      const s = out.get(r.doco_id);
      if (s) s.lastUpdatedAt = r.last_at;
    }
    return out;
  });
}
