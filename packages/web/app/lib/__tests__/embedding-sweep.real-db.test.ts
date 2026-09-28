// The embedding sweep against the real schema: nodes without a vector for
// the configured model get one, in batches, live Docos only, until the
// deadline; a second pass finds nothing to do.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", async () => {
  const actual = await vi.importActual<typeof import("@doco/db")>("@doco/db");
  return { ...actual, withClient: (fn: (c: unknown) => unknown) => fn(dbm.db) };
});

import { sweepEmbeddings } from "../embedding-sweep.server";

function fakeProvider(modelId = "test:model") {
  const calls: string[][] = [];
  return {
    modelId,
    dimensions: 3,
    calls,
    async embed(texts: string[]): Promise<Float32Array[]> {
      calls.push(texts);
      return texts.map(() => Float32Array.from([1, 0, 0]));
    },
  };
}

async function embedded() {
  return (
    await dbm.db.query<{ entity_id: string; model_id: string }>(
      "SELECT entity_id, model_id FROM embeddings ORDER BY entity_id",
    )
  ).rows;
}

beforeEach(async () => {
  dbm.db = new PGlite({ extensions: { vector } });
  await dbm.db.exec(schemaSql);
  await dbm.db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data, deleted_at) VALUES
      ('doco_live', 'live', 'ws', 'ws', '{}'::jsonb, NULL),
      ('doco_gone', 'gone', 'ws', 'ws', '{}'::jsonb, now());
    INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose) VALUES
      ('decision_1', 'doco_live', 'decision', 'active', 'Ship the apple pie'),
      ('decision_2', 'doco_live', 'decision', 'active', 'Bake banana bread'),
      ('decision_blank', 'doco_live', 'decision', 'drafting', ''),
      ('decision_done', 'doco_live', 'decision', 'active', 'Already embedded'),
      ('decision_old', 'doco_live', 'decision', 'active', 'Embedded by an older model'),
      ('decision_deleted', 'doco_gone', 'decision', 'active', 'In a deleted Doco');
    INSERT INTO embeddings
      (doco_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
    VALUES
      ('doco_live', 'node', 'decision_done', 0, 'test:model', 'h', 'Already embedded', ('[1' || repeat(',0', 1535) || ']')::vector),
      ('doco_live', 'node', 'decision_old', 0, 'old:model', 'h', 'Embedded by an older model', ('[1' || repeat(',0', 1535) || ']')::vector);
  `);
});

describe("sweepEmbeddings", () => {
  it("embeds the nodes that lack a vector for this model, in live Docos, then has nothing left", async () => {
    const provider = fakeProvider();
    const first = await sweepEmbeddings({ provider, deadlineMs: 10_000 });

    expect(first).toEqual({ nodes: 3, batches: 1, exhausted: true });
    expect(provider.calls).toEqual([
      ["Ship the apple pie", "Bake banana bread", "Embedded by an older model"],
    ]);
    expect(await embedded()).toEqual([
      { entity_id: "decision_1", model_id: "test:model" },
      { entity_id: "decision_2", model_id: "test:model" },
      { entity_id: "decision_done", model_id: "test:model" },
      { entity_id: "decision_old", model_id: "test:model" },
    ]);

    const second = await sweepEmbeddings({ provider, deadlineMs: 10_000 });
    expect(second).toEqual({ nodes: 0, batches: 0, exhausted: true });
    expect(provider.calls).toHaveLength(1);
  });

  it("stops at the deadline after a batch and picks up next time", async () => {
    const provider = fakeProvider();
    const cut = await sweepEmbeddings({ provider, deadlineMs: 0 });
    expect(cut).toMatchObject({ batches: 1, exhausted: false });

    const rest = await sweepEmbeddings({ provider, deadlineMs: 10_000 });
    expect(rest.exhausted).toBe(true);
  });

  it("can be scoped to one Doco", async () => {
    const provider = fakeProvider();
    await dbm.db.query("UPDATE docos SET deleted_at = NULL WHERE id = 'doco_gone'");
    const result = await sweepEmbeddings({ provider, docoId: "doco_gone", deadlineMs: 10_000 });
    expect(result).toEqual({ nodes: 1, batches: 1, exhausted: true });
    expect((await embedded()).map((r) => r.entity_id)).toContain("decision_deleted");
    expect((await embedded()).map((r) => r.entity_id)).not.toContain("decision_1");
  });
});
