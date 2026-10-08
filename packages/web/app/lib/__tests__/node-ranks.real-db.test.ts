// PageRank stored per node: a change to a Doco's edges queues the Doco, and
// the next refresh ranks its nodes over its live edges, directed, scaled so
// the average node of the graph ranks 1. Briefs and search read the stored
// rank instead of loading every edge on each request.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { loadNodeRanks, refreshNodeRanks } from "../node-ranks.server";

let db: PGlite;

async function edge(id: string, doco: string, from: string, to: string): Promise<void> {
  await db.query(
    `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type)
     VALUES ($1, $2, 'supports', $3, split_part($3, '_', 1), $4, split_part($4, '_', 1))`,
    [id, doco, from, to],
  );
}

async function stale(): Promise<string[]> {
  return (
    await db.query<{ doco_id: string }>(
      "SELECT DISTINCT doco_id FROM node_ranks_stale ORDER BY doco_id",
    )
  ).rows.map((r) => r.doco_id);
}

async function ranks(): Promise<Record<string, number>> {
  const rows = (
    await db.query<{ node_id: string; rank: number }>("SELECT node_id, rank FROM node_ranks")
  ).rows;
  return Object.fromEntries(rows.map((r) => [r.node_id, r.rank]));
}

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_1', 'one', 'ws', 'ws', '{}'::jsonb),
      ('doco_2', 'two', 'ws', 'ws', '{}'::jsonb);
    INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose) VALUES
      ('intent_1', 'doco_1', 'intent', 'active', 'Intent'),
      ('decision_1', 'doco_1', 'decision', 'active', 'Decision'),
      ('action_e1', 'doco_1', 'action', 'active', 'Event 1'),
      ('action_e2', 'doco_1', 'action', 'active', 'Event 2'),
      ('action_e3', 'doco_1', 'action', 'active', 'Event 3'),
      ('action_a1', 'doco_1', 'action', 'active', 'Action 1'),
      ('action_a2', 'doco_1', 'action', 'active', 'Action 2'),
      ('decision_lonely', 'doco_1', 'decision', 'active', 'No edges'),
      ('intent_2', 'doco_2', 'intent', 'active', 'Intent two'),
      ('decision_2', 'doco_2', 'decision', 'active', 'Decision two');
  `);
  // Three events serve the intent; the decision fans out to two actions.
  await edge("edge_1", "doco_1", "action_e1", "intent_1");
  await edge("edge_2", "doco_1", "action_e2", "intent_1");
  await edge("edge_3", "doco_1", "action_e3", "intent_1");
  await edge("edge_4", "doco_1", "decision_1", "action_a1");
  await edge("edge_5", "doco_1", "decision_1", "action_a2");
  await edge("edge_6", "doco_2", "decision_2", "intent_2");
});

describe("node ranks", () => {
  it("ranks the Docos whose edges changed, once, over their own edges", async () => {
    expect(await stale()).toEqual(["doco_1", "doco_2"]);
    expect(await refreshNodeRanks(db)).toEqual({ docos: 2, exhausted: true });
    expect(await stale()).toEqual([]);

    const r = await ranks();
    // Directed: the intent many nodes point at is the authority.
    expect(r.intent_1).toBeGreaterThan(r.decision_1);
    expect(r.intent_2).toBeGreaterThan(r.decision_2);
    // A node with no edge has no rank.
    expect(r).not.toHaveProperty("decision_lonely");
    // Scaled to its own Doco's graph: the average node ranks 1.
    const one = [
      "intent_1",
      "decision_1",
      "action_e1",
      "action_e2",
      "action_e3",
      "action_a1",
      "action_a2",
    ];
    expect(one.reduce((sum, id) => sum + (r[id] ?? 0), 0) / one.length).toBeCloseTo(1, 6);
    expect((r.intent_2 + r.decision_2) / 2).toBeCloseTo(1, 6);

    // Nothing changed since: nothing to do.
    expect(await refreshNodeRanks(db)).toEqual({ docos: 0, exhausted: true });
  });

  it("drops what a retired edge gave and leaves other Docos alone", async () => {
    await refreshNodeRanks(db);
    const before = await ranks();
    await db.query(
      "UPDATE edges SET lifecycle = 'retired', retired_at = now() WHERE id = 'edge_1'",
    );
    expect(await stale()).toEqual(["doco_1"]);
    expect(await refreshNodeRanks(db)).toEqual({ docos: 1, exhausted: true });
    const after = await ranks();
    expect(after).not.toHaveProperty("action_e1");
    expect(after.intent_1).toBeLessThan(before.intent_1);
    expect(after.intent_2).toBe(before.intent_2);
  });

  it("stops at the deadline and leaves the rest queued", async () => {
    expect(await refreshNodeRanks(db, { deadlineMs: -1 })).toEqual({ docos: 0, exhausted: false });
    expect(await stale()).toEqual(["doco_1", "doco_2"]);
  });

  it("reads the stored ranks of the nodes asked for", async () => {
    await refreshNodeRanks(db);
    const r = await loadNodeRanks(db, ["intent_1", "decision_lonely", "missing"]);
    expect([...r.keys()]).toEqual(["intent_1"]);
    expect(r.get("intent_1")).toBe((await ranks()).intent_1);
  });
});
