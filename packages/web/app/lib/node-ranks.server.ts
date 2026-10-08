// PageRank stored per node (schema.sql, node_ranks;
// decision_01M4EXESAH2XENAB3B612P8ZAR). A write to a Doco's edges queues the
// Doco; the refresh drains the queue and ranks each queued Doco's nodes once,
// over its live edges, directed (a node many others point at is an
// authority), scaled so the average node of the graph ranks 1. Briefs and
// search read a node's rank instead of loading every edge on each request.
import type { QueryClient } from "@doco/db";
import { globalPageRank } from "@doco/index";

export interface NodeRanksRefresh {
  /** Docos ranked in this pass. */
  docos: number;
  /** True when the queue was empty when the pass ended. */
  exhausted: boolean;
}

/** Rank the queued Docos, one at a time, until the queue is empty or the
 *  deadline passes. A Doco that fails stays queued for the next pass. */
export async function refreshNodeRanks(
  c: QueryClient,
  opts: { deadlineMs?: number } = {},
): Promise<NodeRanksRefresh> {
  const deadline = Date.now() + (opts.deadlineMs ?? 5_000);
  const failed: string[] = [];
  let docos = 0;
  for (;;) {
    const next = (
      await c.query<{ doco_id: string }>(
        "SELECT doco_id FROM node_ranks_stale WHERE doco_id <> ALL($1::text[]) LIMIT 1",
        [failed],
      )
    ).rows[0];
    if (!next) return { docos, exhausted: failed.length === 0 };
    if (Date.now() > deadline) return { docos, exhausted: false };
    try {
      await rankDoco(c, next.doco_id);
      docos++;
    } catch (e) {
      console.error(`[node-ranks] ${next.doco_id}: ${(e as Error).message}`);
      failed.push(next.doco_id);
    }
  }
}

/** The stored rank of each of `ids` that has one. */
export async function loadNodeRanks(c: QueryClient, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = (
    await c.query<{ node_id: string; rank: number }>(
      "SELECT node_id, rank FROM node_ranks WHERE node_id = ANY($1::text[])",
      [ids],
    )
  ).rows;
  return new Map(rows.map((row) => [row.node_id, row.rank]));
}

async function rankDoco(c: QueryClient, docoId: string): Promise<void> {
  await c.query("BEGIN");
  try {
    // One refresh of a Doco at a time: a second waits, then ranks from a
    // newer snapshot, so an older result never lands last.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('node_ranks:' || $1))", [docoId]);
    await c.query("DELETE FROM node_ranks_stale WHERE doco_id = $1", [docoId]);
    const edges = (
      await c.query<{ from_id: string; to_id: string; edge_type: string }>(
        `SELECT from_id, to_id, edge_type FROM edges
          WHERE doco_id = $1 AND lifecycle <> 'retired'`,
        [docoId],
      )
    ).rows;
    const ranked = globalPageRank(
      edges.map((e) => ({ from: e.from_id, to: e.to_id, edge_type: e.edge_type })),
      { alpha: 0.85, directed: true },
    );
    await c.query(
      "DELETE FROM node_ranks r USING nodes n WHERE n.id = r.node_id AND n.doco_id = $1",
      [docoId],
    );
    if (ranked.length > 0) {
      await c.query(
        `INSERT INTO node_ranks (node_id, rank)
         SELECT * FROM unnest($1::text[], $2::float8[])
         ON CONFLICT (node_id) DO UPDATE SET rank = EXCLUDED.rank`,
        [ranked.map((p) => p.id), ranked.map((p) => p.score * ranked.length)],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}
