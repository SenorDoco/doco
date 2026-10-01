// Semantic ranking over pgvector chunk rows: each node's nearest chunk,
// scoped to the Doco, to the query's model and to the active filters, fused
// with the full-text floor. PGlite runs the real schema and pgvector.
import { vectorLiteral } from "@doco/db";
import { describe, expect, it } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import type { SearchFilters } from "../search-filters.server";
import { hybridSearch, rankSearchEmbeddings } from "../search.server";

type Client = Parameters<typeof rankSearchEmbeddings>[0];

const ALL: SearchFilters = { lifecycle: null, nodeType: null, limit: 100 };
const MODEL = "test:model";
const APPLE = { queryEmbedding: Float32Array.from([1, 0, 0]), modelId: MODEL };

async function seed(): Promise<Client> {
  const db = await freshDb();
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS')");
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_1','d','ws','ws','{}'::jsonb)",
  );
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose) VALUES
       ('decision_apple', 'doco_1', 'decision', 'active', 'Ship the apple pie'),
       ('decision_banana', 'doco_1', 'decision', 'drafting', 'Bake banana bread'),
       ('decision_stale', 'doco_1', 'decision', 'active', 'Embedded by another model')`,
  );
  // decision_apple has two chunks; its best one for an apple query is the second.
  await db.query(
    `INSERT INTO embeddings
       (doco_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
     VALUES
       ('doco_1', 'node', 'decision_apple', 0, $1, 'h0', 'cherry', $3::vector),
       ('doco_1', 'node', 'decision_apple', 1, $1, 'h1', 'apple', $2::vector),
       ('doco_1', 'node', 'decision_banana', 0, $1, 'h2', 'banana', $4::vector),
       ('doco_1', 'node', 'decision_stale', 0, 'other:model', 'h3', 'apple', $2::vector)`,
    [MODEL, vectorLiteral([1, 0, 0]), vectorLiteral([0, 0, 1]), vectorLiteral([0, 1, 0])],
  );
  return db as unknown as Client;
}

describe("rankSearchEmbeddings", () => {
  it("ranks nodes by their nearest chunk, for the query's model only", async () => {
    const { hits } = await rankSearchEmbeddings(await seed(), "doco_1", APPLE, ALL, 10);
    expect(hits.map((h) => h.id)).toEqual(["decision_apple", "decision_banana"]);
    expect(hits[0].vector_score).toBeCloseTo(1, 5);
    expect(hits[1].vector_score).toBeCloseTo(0, 5);
  });

  it("honours the lifecycle filter", async () => {
    const { hits } = await rankSearchEmbeddings(
      await seed(),
      "doco_1",
      APPLE,
      { lifecycle: ["drafting"], nodeType: null, limit: 10 },
      10,
    );
    expect(hits.map((h) => h.id)).toEqual(["decision_banana"]);
  });
});

describe("hybridSearch", () => {
  it("uses the vector ranker only when the query carries an embedding", async () => {
    const c = await seed();
    const withVector = await hybridSearch(
      c,
      "doco_1",
      { queryText: "apple", semantic: APPLE },
      ALL,
      10,
    );
    expect(withVector.usedVector).toBe(true);
    expect(withVector.hits[0]?.id).toBe("decision_apple");

    const withoutVector = await hybridSearch(
      c,
      "doco_1",
      { queryText: "apple", semantic: null },
      ALL,
      10,
    );
    expect(withoutVector.usedVector).toBe(false);
  });
});
