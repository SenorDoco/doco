// Real-database exercise of the search FTS floor (the "drafting node the page
// shows but Señor Doco can't find" bug).
//
// Agent search (`/search.json`) was vector-only: it ranked over the
// `embeddings` table, so a node with no embedding row — a content-thin draft,
// or one whose best-effort embedding pass silently failed/lagged — was
// invisible even though it sits in `nodes` and on the page. The FTS index
// (`entity_fts_nodes`) is written inline with every capture, so it's the
// reliable floor. These tests pin that the floor surfaces such nodes, against
// real Postgres full-text semantics (PGlite), not a mock.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import type { SearchFilters } from "../search-filters.server";
import { type SearchHit, hybridSearch, mergeSearchHits, rankSearchFts } from "../search.server";

type Client = Parameters<typeof rankSearchFts>[0];

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const ALL: SearchFilters = { lifecycle: null, entityType: null, limit: 100 };

async function seed(): Promise<Client> {
  const db = new PGlite();
  await db.exec(schemaSql);
  await db.query(
    "INSERT INTO workspaces (id, handle, name, data) VALUES ('ws','ws','WS','{}'::jsonb)",
  );
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_1','d','ws','ws','{}'::jsonb)",
  );
  // An ordinary, embedded node ...
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, ref_type, locator, data)
     VALUES ('reference_embedded','doco_1','reference','active','Widget calibration runbook','url','https://x/1','{}'::jsonb)`,
  );
  // ... and a DRAFTING node with no embedding row, present only in the
  // (synchronously-built) FTS index.
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, ref_type, locator, data)
     VALUES ('reference_draft','doco_1','reference','drafting','Widget calibration draft notes','url','https://x/2','{}'::jsonb)`,
  );
  // FTS rows as the indexer writes them (node body = prose). No embeddings
  // table rows on purpose — that's the whole point.
  await db.query(
    `INSERT INTO entity_fts_nodes (entity_id, doco_id, node_type, summary, body) VALUES
       ('reference_embedded','doco_1','reference',NULL,'Widget calibration runbook'),
       ('reference_draft','doco_1','reference',NULL,'Widget calibration draft notes')`,
  );
  return db as unknown as Client;
}

describe("FTS floor finds nodes the vector index never got", () => {
  it("rankSearchFts returns an un-embedded drafting node by its words", async () => {
    const hits = await rankSearchFts(await seed(), "doco_1", "calibration draft", ALL, 50);
    expect(hits.map((h) => h.id)).toContain("reference_draft");
  });

  it("hybridSearch surfaces the un-embedded node with no provider (queryEmbedding=null)", async () => {
    const { hits, usedVector } = await hybridSearch(
      await seed(),
      "doco_1",
      { queryText: "calibration draft", queryEmbedding: null },
      ALL,
      50,
    );
    expect(usedVector).toBe(false);
    expect(hits.map((h) => h.id)).toContain("reference_draft");
  });

  it("still honours an explicit lifecycle filter", async () => {
    const hits = await rankSearchFts(
      await seed(),
      "doco_1",
      "Widget calibration",
      { lifecycle: ["active"], entityType: null, limit: 50 },
      50,
    );
    expect(hits.map((h) => h.id)).toEqual(["reference_embedded"]);
  });
});

describe("mergeSearchHits", () => {
  const hit = (id: string, vector_score: number | null): SearchHit => ({
    id,
    entity_type: "reference",
    summary: id,
    name: null,
    lifecycle: "active",
    created_at: null,
    gpr: 0,
    vector_score,
  });

  it("keeps vector hits first, then appends FTS-only hits (deduped by id)", () => {
    const merged = mergeSearchHits(
      [hit("a", 0.9), hit("b", 0.8)],
      [hit("b", null), hit("c", null)],
    );
    expect(merged.map((h) => h.id)).toEqual(["a", "b", "c"]);
  });

  it("caps to the limit, preserving vector-first order", () => {
    const merged = mergeSearchHits([hit("a", 0.9)], [hit("b", null), hit("c", null)], 2);
    expect(merged.map((h) => h.id)).toEqual(["a", "b"]);
  });
});
