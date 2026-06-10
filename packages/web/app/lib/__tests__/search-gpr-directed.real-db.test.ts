// Real-database exercise of the search GPR (global PageRank) direction fix.
//
// `gpr` used to symmetrize every edge, so an intent that many events "serve"
// (edge from=event → to=intent) had its mass diluted across the star and
// could rank *below* a decision that merely fans out to a few actions. The
// search path now runs a *directed* PageRank, so the intent — the target of
// many edges — accumulates rank as an authority. This pins that against real
// Postgres (PGlite), through the actual `attachSearchGlobalPageRank` query.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { type SearchHit, attachSearchGlobalPageRank } from "../search.server";

type Client = Parameters<typeof attachSearchGlobalPageRank>[0];

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

async function node(db: PGlite, id: string, nodeType: string): Promise<void> {
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose)
     VALUES ($1,'doco_1',$2,'active',$1)`,
    [id, nodeType],
  );
}

async function edge(
  db: PGlite,
  from: string,
  fromType: string,
  to: string,
  toType: string,
  edgeType: string,
): Promise<void> {
  await db.query(
    `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type)
     VALUES ($1,'doco_1',$2,$3,$4,$5,$6)`,
    [`edge_${from}_${to}`, edgeType, from, fromType, to, toType],
  );
}

// Intent I served by three events; decision D fans out to four actions.
async function seed(): Promise<Client> {
  const db = new PGlite();
  await db.exec(schemaSql);
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS')");
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_1','d','ws','ws','{}'::jsonb)",
  );
  await node(db, "intent_1", "intent");
  await node(db, "decision_1", "decision");
  for (const e of ["event_1", "event_2", "event_3"]) await node(db, e, "action");
  for (const a of ["action_1", "action_2", "action_3", "action_4"]) await node(db, a, "action");

  // events serve the intent (from=event → to=intent)
  await edge(db, "event_1", "action", "intent_1", "intent", "supports");
  await edge(db, "event_2", "action", "intent_1", "intent", "supports");
  await edge(db, "event_3", "action", "intent_1", "intent", "supports");
  // decision fans out to actions (from=decision → to=action)
  await edge(db, "decision_1", "decision", "action_1", "action", "flows_to");
  await edge(db, "decision_1", "decision", "action_2", "action", "flows_to");
  await edge(db, "decision_1", "decision", "action_3", "action", "flows_to");
  await edge(db, "decision_1", "decision", "action_4", "action", "flows_to");
  return db as unknown as Client;
}

function hit(id: string, nodeType: string): SearchHit {
  return {
    id,
    node_type: nodeType,
    summary: id,
    name: null,
    lifecycle: "active",
    created_at: null,
    gpr: 0,
    vector_score: null,
  };
}

describe("search gpr is directed", () => {
  it("ranks an intent served by many events above a decision that fans out", async () => {
    const db = await seed();
    const intent = hit("intent_1", "intent");
    const decision = hit("decision_1", "decision");
    await attachSearchGlobalPageRank(db, "doco_1", [intent, decision]);
    expect(intent.gpr).toBeGreaterThan(decision.gpr);
  });
});
