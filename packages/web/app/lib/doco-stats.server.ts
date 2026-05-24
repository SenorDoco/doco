// Per-Doco aggregate stats (Neurons, Active neurons, Synapses, Last updated)
// shown on the dashboard and owner-profile docos tables.
//
// `neurons` counts domain neurons: decisions, intents, rules,
// actions, evals, ideas, reference_entities, logs, states, and the
// Doco's principals. Policies are not neurons and are deliberately
// excluded — they are surfaced via /<handle>/api/policies.json.
// `synapses` reads the materialized `synapses` table.
// `lastUpdatedAt` is the max `at` from `audit_events` — that captures
// both inserts and updates and is cheap because audit_events is
// already indexed by doco_id.

import { withClient } from "@doco/db";

export interface DocoStats {
  neurons: number;
  activeNeurons: number;
  synapses: number;
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

const EMPTY: DocoStats = { neurons: 0, activeNeurons: 0, synapses: 0, lastUpdatedAt: null };

export async function listDocoStats(docoIds: readonly string[]): Promise<Map<string, DocoStats>> {
  const out = new Map<string, DocoStats>();
  if (docoIds.length === 0) return out;
  const ids = [...docoIds];

  return withClient(async (c) => {
    const neuronsSql = STATS_ENTITY_TABLE_SPECS.map(
      (spec) =>
        `SELECT ${spec.docoIdSql} AS doco_id, lifecycle FROM ${spec.table} WHERE ${spec.docoWhereSql}`,
    ).join(" UNION ALL ");
    const [neuronsRows, synapsesRows, updatedRows] = await Promise.all([
      c.query<{ doco_id: string; n: string; active_n: string }>(
        `SELECT doco_id,
                COUNT(*)::text AS n,
                COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'active')::text AS active_n
           FROM (${neuronsSql}) t
          GROUP BY doco_id`,
        [ids],
      ),
      c.query<{ doco_id: string; n: string }>(
        "SELECT doco_id, COUNT(*)::text AS n FROM synapses WHERE doco_id = ANY($1) GROUP BY doco_id",
        [ids],
      ),
      c.query<{ doco_id: string; last_at: string }>(
        "SELECT doco_id, MAX(at)::text AS last_at FROM audit_events WHERE doco_id = ANY($1) GROUP BY doco_id",
        [ids],
      ),
    ]);

    for (const id of ids) out.set(id, { ...EMPTY });
    for (const r of neuronsRows.rows) {
      const s = out.get(r.doco_id);
      if (s) {
        s.neurons = Number(r.n);
        s.activeNeurons = Number(r.active_n);
      }
    }
    for (const r of synapsesRows.rows) {
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
