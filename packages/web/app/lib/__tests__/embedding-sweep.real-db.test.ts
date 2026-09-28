// The embedding sweep against the real schema: nodes without a vector for the
// configured model, Notion pages whose copied content changed since they were
// embedded and Slack messages whose text did, one batch per source in turn,
// live Docos only, until the deadline; a second pass finds nothing to do.
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
    await dbm.db.query<{ source: string; entity_id: string; model_id: string }>(
      "SELECT source, entity_id, model_id FROM embeddings ORDER BY entity_id",
    )
  ).rows;
}

const NOTHING = { nodes: 0, pages: 0, messages: 0, batches: 0, exhausted: true };

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

    INSERT INTO notion_mirrors (doco_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
      VALUES ('doco_live', 'ws_notion', 'Acme', 'bot_1', 'enc', now());
    INSERT INTO notion_pages
      (doco_id, page_id, object, parent_type, title, url, markdown, content_hash, fetch_pending, synced_at, embedded_hash)
    VALUES
      ('doco_live', 'page_new', 'page', 'workspace', 'Roadmap', 'https://n/1', E'# Q4\\n\\nShip the apple pie.', 'c1', false, now(), NULL),
      ('doco_live', 'page_done', 'page', 'workspace', 'Done', 'https://n/2', 'Already embedded.', 'c2', false, now(), 'c2'),
      ('doco_live', 'page_uncopied', 'page', 'workspace', 'Pending', 'https://n/3', '', '', true, NULL, NULL);

    INSERT INTO group_chat_installations (id, provider, workspace_id, doco_workspace_id)
      VALUES ('gci_1', 'slack', 'T1', 'ws');
    INSERT INTO group_chat_mirrors (doco_id, installation_id, team_domain, history_since, consented_at)
      VALUES ('doco_live', 'gci_1', 'acme', now() - interval '1 year', now());
    INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at, excluded) VALUES
      ('doco_live', 'C_ENG', 'eng', now(), false),
      ('doco_live', 'C_HID', 'hidden', now(), true);
    INSERT INTO group_chat_members (doco_id, chat_user_id, display_name, real_name) VALUES
      ('doco_live', 'U_ANA', 'Ana', 'Ana Ruiz'),
      ('doco_live', 'U_BEN', '', 'Ben Ortiz');
    INSERT INTO group_chat_messages (doco_id, channel_id, ts, author_id, text, posted_at, embedded_hash) VALUES
      ('doco_live', 'C_ENG', '1700000100.000100', 'U_ANA', 'the pooler is full, <@U_BEN> can you look?', to_timestamp(1700000100), NULL),
      ('doco_live', 'C_ENG', '1700000200.000100', 'U_BEN', 'already embedded', to_timestamp(1700000200), md5('already embedded')),
      ('doco_live', 'C_ENG', '1700000300.000100', 'U_ANA', '', to_timestamp(1700000300), NULL),
      ('doco_live', 'C_HID', '1700000400.000100', 'U_ANA', 'in an excluded channel', to_timestamp(1700000400), NULL);
  `);
});

describe("sweepEmbeddings", () => {
  it("embeds what each source has pending, in live Docos, then has nothing left", async () => {
    const provider = fakeProvider();
    const first = await sweepEmbeddings({ provider, deadlineMs: 10_000 });

    expect(first).toEqual({ nodes: 3, pages: 1, messages: 2, batches: 3, exhausted: true });
    expect(provider.calls).toEqual([
      ["Ship the apple pie", "Bake banana bread", "Embedded by an older model"],
      ["Roadmap › Q4\n\nShip the apple pie."],
      ["#eng — Ana: the pooler is full, @Ben Ortiz can you look?"],
    ]);
    expect(await embedded()).toEqual([
      { source: "slack", entity_id: "C_ENG:1700000100.000100", model_id: "test:model" },
      { source: "node", entity_id: "decision_1", model_id: "test:model" },
      { source: "node", entity_id: "decision_2", model_id: "test:model" },
      { source: "node", entity_id: "decision_done", model_id: "test:model" },
      { source: "node", entity_id: "decision_old", model_id: "test:model" },
      { source: "notion", entity_id: "page_new", model_id: "test:model" },
    ]);

    const second = await sweepEmbeddings({ provider, deadlineMs: 10_000 });
    expect(second).toEqual(NOTHING);
    expect(provider.calls).toHaveLength(3);
  });

  it("marks the pages and messages it embedded, the blank message included", async () => {
    await sweepEmbeddings({ provider: fakeProvider(), deadlineMs: 10_000 });

    const pages = await dbm.db.query<{ page_id: string; embedded_hash: string | null }>(
      "SELECT page_id, embedded_hash FROM notion_pages ORDER BY page_id",
    );
    expect(pages.rows).toEqual([
      { page_id: "page_done", embedded_hash: "c2" },
      { page_id: "page_new", embedded_hash: "c1" },
      { page_id: "page_uncopied", embedded_hash: null },
    ]);
    const messages = await dbm.db.query<{ channel_id: string; ts: string; current: boolean }>(
      `SELECT channel_id, ts, embedded_hash = md5(text) AS current
         FROM group_chat_messages ORDER BY ts`,
    );
    expect(messages.rows).toEqual([
      { channel_id: "C_ENG", ts: "1700000100.000100", current: true },
      { channel_id: "C_ENG", ts: "1700000200.000100", current: true },
      { channel_id: "C_ENG", ts: "1700000300.000100", current: true },
      { channel_id: "C_HID", ts: "1700000400.000100", current: null },
    ]);
  });

  it("re-embeds a page whose content changed and a message that was edited", async () => {
    const provider = fakeProvider();
    await sweepEmbeddings({ provider, deadlineMs: 10_000 });
    await dbm.db.exec(`
      UPDATE notion_pages SET markdown = 'Ship the cherry pie.', content_hash = 'c1b'
       WHERE page_id = 'page_new';
      UPDATE group_chat_messages SET text = 'the pooler is fine now' WHERE ts = '1700000100.000100';
    `);

    const again = await sweepEmbeddings({ provider, deadlineMs: 10_000 });

    expect(again).toEqual({ nodes: 0, pages: 1, messages: 1, batches: 2, exhausted: true });
    expect(provider.calls.slice(3)).toEqual([
      ["Roadmap\n\nShip the cherry pie."],
      ["#eng — Ana: the pooler is fine now"],
    ]);
    const chunks = await dbm.db.query<{ entity_id: string; chunk_text: string }>(
      "SELECT entity_id, chunk_text FROM embeddings WHERE source <> 'node' ORDER BY entity_id",
    );
    expect(chunks.rows).toEqual([
      { entity_id: "C_ENG:1700000100.000100", chunk_text: "#eng — Ana: the pooler is fine now" },
      { entity_id: "page_new", chunk_text: "Roadmap\n\nShip the cherry pie." },
    ]);
    expect(await sweepEmbeddings({ provider, deadlineMs: 10_000 })).toEqual(NOTHING);
  });

  it("stops at the deadline after a batch and picks up next time", async () => {
    const provider = fakeProvider();
    const cut = await sweepEmbeddings({ provider, deadlineMs: 0 });
    expect(cut).toMatchObject({ batches: 1, exhausted: false });

    const rest = await sweepEmbeddings({ provider, deadlineMs: 10_000 });
    expect(rest.exhausted).toBe(true);
    expect(rest.batches).toBe(2);
  });

  it("can be scoped to one Doco", async () => {
    const provider = fakeProvider();
    await dbm.db.query("UPDATE docos SET deleted_at = NULL WHERE id = 'doco_gone'");
    const result = await sweepEmbeddings({ provider, docoId: "doco_gone", deadlineMs: 10_000 });
    expect(result).toEqual({ nodes: 1, pages: 0, messages: 0, batches: 1, exhausted: true });
    expect((await embedded()).map((r) => r.entity_id)).toContain("decision_deleted");
    expect((await embedded()).map((r) => r.entity_id)).not.toContain("decision_1");
  });
});
