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
import { nodeIndexText } from "@doco/index";
import type { LoadedEntity } from "@doco/shared";
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
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS')");
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_1','d','ws','ws','{}'::jsonb)",
  );
  // An ordinary, embedded node ...
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes)
     VALUES ('reference_embedded','doco_1','reference','active','Widget calibration runbook', jsonb_build_object('ref_type','url','locator','https://x/1'))`,
  );
  // ... and a DRAFTING node with no embedding row, present only in the
  // (synchronously-built) FTS index.
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes)
     VALUES ('reference_draft','doco_1','reference','drafting','Widget calibration draft notes', jsonb_build_object('ref_type','url','locator','https://x/2'))`,
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

describe("mergeSearchHits (reciprocal rank fusion)", () => {
  const hit = (id: string, vector_score: number | null, gpr = 0): SearchHit => ({
    id,
    entity_type: "reference",
    summary: id,
    name: null,
    lifecycle: "active",
    created_at: null,
    gpr,
    vector_score,
  });

  it("unions and dedupes by id, keeping every distinct hit once", () => {
    const merged = mergeSearchHits(
      [hit("a", 0.9), hit("b", 0.8)],
      [hit("b", null), hit("c", null)],
    );
    expect([...merged.map((h) => h.id)].sort()).toEqual(["a", "b", "c"]);
  });

  it("corroborates: a hit ranked by BOTH vector and FTS outranks single-list hits", () => {
    // `b` is rank 1 by cosine but also present in FTS — two rank contributions
    // lift it above `a`, which only the vector ranker saw. This is the RRF
    // upgrade over plain concatenation (which kept `a` first unconditionally).
    const merged = mergeSearchHits(
      [hit("a", 0.9), hit("b", 0.8)],
      [hit("b", null), hit("c", null)],
    );
    expect(merged[0].id).toBe("b");
  });

  it("ignores PageRank when its weight is 0 — pure cosine order", () => {
    const merged = mergeSearchHits(
      [hit("a", 0.9, 0.1), hit("b", 0.8, 0.1), hit("c", 0.7, 0.9)],
      [],
      undefined,
      { pagerankWeight: 0 },
    );
    expect(merged.map((h) => h.id)).toEqual(["a", "b", "c"]);
  });

  it("factors in PageRank: a high-PageRank, low-cosine hit climbs as weight rises", () => {
    // `c` is the worst cosine match but the top authority. With enough
    // PageRank weight it overtakes the better-matching but peripheral nodes.
    const vectorHits = [hit("a", 0.9, 0.1), hit("b", 0.8, 0.1), hit("c", 0.7, 0.9)];
    expect(
      mergeSearchHits(vectorHits, [], undefined, { pagerankWeight: 0 }).map((h) => h.id),
    ).toEqual(["a", "b", "c"]);
    expect(mergeSearchHits(vectorHits, [], undefined, { pagerankWeight: 5 })[0].id).toBe("c");
  });

  it("caps to the limit after fusing", () => {
    const merged = mergeSearchHits([hit("a", 0.9)], [hit("b", null), hit("c", null)], 2);
    expect(merged).toHaveLength(2);
  });
});

// Title/body split — search recall is preserved.
//
// After the split a PR reference stores ONLY the title in `prose`; the body
// lives in `attributes.body_md`. The indexer's FTS `body` is `nodeIndexText`,
// which now appends body_md to the prose — so a keyword that appears ONLY in the
// PR body must still find the reference. This drives the REAL `nodeIndexText`
// (the function the production indexer calls) to build the FTS body, then runs
// real Postgres FTS over it.
describe("title/body split keeps a body-only keyword findable", () => {
  // A reference as the Postgres loader hydrates it: `typeNamedValue` is the
  // prose (the PR title), and the `attributes.body_md` is surfaced as a flat
  // `body_md` key on `data` (rowToRecord flattens the attributes bag on read).
  function referenceLe(id: string, title: string, bodyMd: string): LoadedEntity {
    return {
      entity: { id } as unknown as LoadedEntity["entity"],
      filePath: `<postgres>:reference/${id}`,
      parsed: {
        data: { id, node_type: "reference", ref_type: "url", body_md: bodyMd },
        body: "",
        format: "postgres",
        typeNamedValue: title,
      },
    } as LoadedEntity;
  }

  async function seedSplitReference(): Promise<Client> {
    const db = new PGlite();
    await db.exec(schemaSql);
    await db.query("INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS')");
    await db.query(
      "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_1','d','ws','ws','{}'::jsonb)",
    );
    const title = "Fix the retry on 409";
    // The distinctive word "thundering" lives ONLY in the body, never the title.
    const bodyMd = "### Problem\n\nA thundering herd of retries overwhelmed the gateway.";
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes)
       VALUES ('reference_split','doco_1','reference','active',$1,
               jsonb_build_object('ref_type','url','locator','https://github.com/o/r/pull/9','body_md',$2::text))`,
      [title, bodyMd],
    );
    // FTS body exactly as the indexer writes it — via the REAL nodeIndexText.
    const ftsBody = nodeIndexText(referenceLe("reference_split", title, bodyMd));
    // Guard the recall-identity: the indexed text is the pre-split merged prose.
    expect(ftsBody).toBe(`${title}\n\n${bodyMd}`);
    await db.query(
      `INSERT INTO entity_fts_nodes (entity_id, doco_id, node_type, summary, body)
       VALUES ('reference_split','doco_1','reference',NULL,$1)`,
      [ftsBody],
    );
    return db as unknown as Client;
  }

  it("finds the reference by a word that only appears in the PR body", async () => {
    const hits = await rankSearchFts(
      await seedSplitReference(),
      "doco_1",
      "thundering herd",
      ALL,
      50,
    );
    expect(hits.map((h) => h.id)).toContain("reference_split");
  });

  it("a title-only FTS body (the pre-fix regression) would NOT match the body word", async () => {
    // Pin the regression the fix prevents: if the FTS body were the title alone
    // (what a naive split would store), the body keyword finds nothing.
    const db = new PGlite();
    await db.exec(schemaSql);
    await db.query("INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS')");
    await db.query(
      "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_1','d','ws','ws','{}'::jsonb)",
    );
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes)
       VALUES ('reference_titleonly','doco_1','reference','active','Fix the retry on 409',
               jsonb_build_object('ref_type','url','locator','https://github.com/o/r/pull/9'))`,
    );
    await db.query(
      `INSERT INTO entity_fts_nodes (entity_id, doco_id, node_type, summary, body)
       VALUES ('reference_titleonly','doco_1','reference',NULL,'Fix the retry on 409')`,
    );
    const hits = await rankSearchFts(db as unknown as Client, "doco_1", "thundering herd", ALL, 50);
    expect(hits.map((h) => h.id)).not.toContain("reference_titleonly");
  });
});
