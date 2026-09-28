// Semantic ranking over pgvector chunk rows: each node's nearest chunk,
// scoped to the Doco, to the query's model and to the active filters, fused
// with the full-text floor. PGlite runs the real schema and pgvector.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vectorLiteral } from "@doco/db";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { describe, expect, it } from "vitest";
import type { SearchFilters } from "../search-filters.server";
import { hybridSearch, rankSearchEmbeddings } from "../search.server";

type Client = Parameters<typeof rankSearchEmbeddings>[0];

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const ALL: SearchFilters = { lifecycle: null, nodeType: null, limit: 100 };
const MODEL = "test:model";

async function seed(): Promise<Client> {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
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
    const { hits } = await rankSearchEmbeddings(
      await seed(),
      "doco_1",
      Float32Array.from([1, 0, 0]),
      ALL,
      10,
      MODEL,
    );
    expect(hits.map((h) => h.id)).toEqual(["decision_apple", "decision_banana"]);
    expect(hits[0].vector_score).toBeCloseTo(1, 5);
    expect(hits[1].vector_score).toBeCloseTo(0, 5);
  });

  it("honours the lifecycle filter", async () => {
    const { hits } = await rankSearchEmbeddings(
      await seed(),
      "doco_1",
      Float32Array.from([1, 0, 0]),
      { lifecycle: ["drafting"], nodeType: null, limit: 10 },
      10,
      MODEL,
    );
    expect(hits.map((h) => h.id)).toEqual(["decision_banana"]);
  });
});

describe("hybridSearch", () => {
  it("uses the vector ranker only when the query carries an embedding and its model", async () => {
    const c = await seed();
    const withModel = await hybridSearch(
      c,
      "doco_1",
      { queryText: "apple", queryEmbedding: Float32Array.from([1, 0, 0]), modelId: MODEL },
      ALL,
      10,
    );
    expect(withModel.usedVector).toBe(true);
    expect(withModel.hits[0]?.id).toBe("decision_apple");

    const withoutModel = await hybridSearch(
      c,
      "doco_1",
      { queryText: "apple", queryEmbedding: Float32Array.from([1, 0, 0]) },
      ALL,
      10,
    );
    expect(withoutModel.usedVector).toBe(false);
  });
});
