// Real-DB exercise of the Notion mirror's live path: every webhook delivery
// flags the page it concerns for the sync to fetch, a deletion is real, and
// the schema keeps a mirror Doco private. PGlite runs the real schema; only
// @doco/db's withClient is pointed at it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));

import {
  deleteNotionPage,
  flagNotionPage,
  mirrorNotionEvent,
  parentOf,
  upsertNotionUsers,
} from "../notion-mirror.server";

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const BOT = "bot-1";
const ROOT = "aaaaaaaa-0000-0000-0000-000000000001";
const CHILD = "aaaaaaaa-0000-0000-0000-000000000002";
const GRANDCHILD = "aaaaaaaa-0000-0000-0000-000000000003";
const DATA_SOURCE = "bbbbbbbb-0000-0000-0000-000000000001";
const ROW = "bbbbbbbb-0000-0000-0000-000000000002";

function event(type: string, entityId: string, extra: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    timestamp: "2026-09-28T10:00:00.000Z",
    workspace_id: WORKSPACE,
    type,
    entity: { id: entityId, type: type.split(".")[0] },
    accessible_by: [{ id: BOT, type: "bot" }],
    ...extra,
  };
}

async function pages() {
  const r = await dbm.db.query<{
    page_id: string;
    object: string;
    parent_id: string | null;
    parent_type: string | null;
    url: string;
    fetch_pending: boolean;
    fetch_reason: string | null;
    fetch_attempts: number;
  }>(
    `SELECT page_id, object, parent_id, parent_type, url, fetch_pending, fetch_reason, fetch_attempts
       FROM notion_pages ORDER BY page_id`,
  );
  return r.rows;
}

beforeEach(async () => {
  const db = new PGlite();
  await db.exec(schemaSql);
  dbm.db = db;
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'acme', 'Acme');
    INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
      ('doco_notion', 'acme-notion', 'workspace_1', 'workspace_1', 'private', '{}'::jsonb),
      ('doco_public', 'acme-public', 'workspace_1', 'workspace_1', 'public', '{}'::jsonb);
    INSERT INTO notion_mirrors (doco_id, workspace_id, bot_id, access_token, consented_at)
      VALUES ('doco_notion', '${WORKSPACE}', '${BOT}', 'v1:enc', now());
    INSERT INTO notion_pages (doco_id, page_id, object, parent_id, parent_type, url, title,
                              fetch_pending, fetch_attempts, synced_at) VALUES
      ('doco_notion', '${ROOT}', 'page', NULL, 'workspace', 'https://www.notion.so/root', 'Root', false, 3, now()),
      ('doco_notion', '${CHILD}', 'page', '${ROOT}', 'page', 'https://www.notion.so/child', 'Child', false, 0, now()),
      ('doco_notion', '${GRANDCHILD}', 'page', '${CHILD}', 'page', 'https://www.notion.so/gc', 'Grandchild', false, 0, now()),
      ('doco_notion', '${DATA_SOURCE}', 'data_source', '${ROOT}', 'page', 'https://www.notion.so/ds', 'Tasks', false, 0, now()),
      ('doco_notion', '${ROW}', 'page', '${DATA_SOURCE}', 'data_source', 'https://www.notion.so/row', 'A task', false, 0, now());
    INSERT INTO notion_links (doco_id, from_page_id, to_page_id) VALUES
      ('doco_notion', '${CHILD}', '${ROOT}');
  `);
});

describe("mirroring Notion events", () => {
  it("flags a new page as a stub for the sync to fetch, with its parent", async () => {
    const newPage = "cccccccc-0000-0000-0000-000000000001";
    const result = await mirrorNotionEvent(
      event("page.created", newPage, { data: { parent: { id: ROOT, type: "page" } } }),
    );

    expect(result).toEqual({ docoIds: ["doco_notion"] });
    expect((await pages()).find((p) => p.page_id === newPage)).toEqual({
      page_id: newPage,
      object: "page",
      parent_id: ROOT,
      parent_type: "page",
      url: "https://www.notion.so/cccccccc000000000000000000000001",
      fetch_pending: true,
      fetch_reason: "webhook",
      fetch_attempts: 0,
    });
  });

  it("re-flags an existing page and resets its retry count, keeping a parent the event omits", async () => {
    await mirrorNotionEvent(event("page.content_updated", ROOT, { data: { updated_blocks: [] } }));

    expect((await pages()).find((p) => p.page_id === ROOT)).toMatchObject({
      parent_type: "workspace",
      fetch_pending: true,
      fetch_reason: "webhook",
      fetch_attempts: 0,
    });
  });

  it("deletes a trashed page and everything beneath it", async () => {
    await mirrorNotionEvent(event("page.deleted", CHILD));

    expect((await pages()).map((p) => p.page_id)).toEqual([ROOT, DATA_SOURCE, ROW]);
    const links = await dbm.db.query("SELECT 1 FROM notion_links");
    expect(links.rows).toHaveLength(0);
  });

  it("re-renders every row when a data source's schema changes", async () => {
    await mirrorNotionEvent(
      event("data_source.schema_updated", DATA_SOURCE, {
        data: { parent: { id: ROOT, type: "page" }, updated_properties: [] },
      }),
    );

    const rows = await pages();
    expect(rows.find((p) => p.page_id === DATA_SOURCE)).toMatchObject({
      fetch_pending: true,
      fetch_reason: "webhook",
    });
    expect(rows.find((p) => p.page_id === ROW)).toMatchObject({
      fetch_pending: true,
      fetch_reason: "schema",
    });
    expect(rows.find((p) => p.page_id === CHILD)).toMatchObject({ fetch_pending: false });
  });

  it("drops a deleted data source with its rows", async () => {
    await mirrorNotionEvent(event("data_source.deleted", DATA_SOURCE));

    expect((await pages()).map((p) => p.page_id)).toEqual([ROOT, CHILD, GRANDCHILD]);
  });

  it("reads Notion's older database events as data source events", async () => {
    await mirrorNotionEvent(event("database.content_updated", DATA_SOURCE));

    expect((await pages()).find((p) => p.page_id === DATA_SOURCE)).toMatchObject({
      object: "data_source",
      fetch_pending: true,
    });
  });

  it("flags the page a comment belongs to", async () => {
    await mirrorNotionEvent(
      event("comment.created", "dddddddd-0000-0000-0000-000000000001", {
        data: { page_id: CHILD, parent: { id: CHILD, type: "page" } },
      }),
    );

    expect((await pages()).find((p) => p.page_id === CHILD)).toMatchObject({
      fetch_pending: true,
      fetch_reason: "webhook",
    });
  });

  it("ignores lock and unlock, which change no content", async () => {
    await mirrorNotionEvent(event("page.locked", ROOT));
    expect((await pages()).find((p) => p.page_id === ROOT)).toMatchObject({ fetch_pending: false });
  });

  it("ignores events for a workspace nobody mirrors, and for another bot", async () => {
    const other = await mirrorNotionEvent({ ...event("page.created", ROOT), workspace_id: "w2" });
    const otherBot = await mirrorNotionEvent(
      event("page.created", ROOT, { accessible_by: [{ id: "bot-9", type: "bot" }] }),
    );

    expect(other).toEqual({ docoIds: [] });
    expect(otherBot).toEqual({ docoIds: [] });
    expect((await pages()).find((p) => p.page_id === ROOT)).toMatchObject({ fetch_pending: false });
  });

  it("routes by workspace when the event names no bots", async () => {
    const result = await mirrorNotionEvent(
      event("page.created", ROOT, { accessible_by: [{ id: "person-1", type: "person" }] }),
    );
    expect(result).toEqual({ docoIds: ["doco_notion"] });
  });

  it("skips a deleted Doco's mirror", async () => {
    await dbm.db.query("UPDATE docos SET deleted_at = now() WHERE id = 'doco_notion'");
    expect(await mirrorNotionEvent(event("page.created", ROOT))).toEqual({ docoIds: [] });
  });
});

describe("row helpers", () => {
  it("reads a parent from an event or object, in either spelling", () => {
    expect(parentOf({ parent: { id: ROOT, type: "page" } })).toEqual({
      parentId: ROOT,
      parentType: "page",
    });
    expect(parentOf({ parent: { type: "data_source_id", data_source_id: DATA_SOURCE } })).toEqual({
      parentId: DATA_SOURCE,
      parentType: "data_source",
    });
    expect(parentOf({ parent: { type: "space", id: "s1" } })).toEqual({
      parentId: null,
      parentType: "workspace",
    });
    expect(parentOf({ parent: { type: "workspace", workspace: true } })).toEqual({
      parentId: null,
      parentType: "workspace",
    });
    expect(parentOf({})).toEqual({ parentId: null, parentType: null });
  });

  it("flags with a fetch reason and deletes recursively", async () => {
    await flagNotionPage("doco_notion", GRANDCHILD, "page", "retry");
    expect((await pages()).find((p) => p.page_id === GRANDCHILD)).toMatchObject({
      fetch_pending: true,
      fetch_reason: "retry",
    });

    await deleteNotionPage("doco_notion", ROOT);
    expect(await pages()).toEqual([]);
  });

  it("upserts people in one write", async () => {
    await upsertNotionUsers("doco_notion", [
      { object: "user", id: "u1", type: "person", name: "Tania", avatar_url: "https://a/t.png" },
      { object: "user", id: "b1", type: "bot", name: "Doco" },
      { object: "user" },
    ]);
    await upsertNotionUsers("doco_notion", [{ id: "u1", type: "person", name: "Tania Z." }]);

    const r = await dbm.db.query<{ user_id: string; name: string; is_bot: boolean }>(
      "SELECT user_id, name, is_bot FROM notion_users ORDER BY user_id",
    );
    expect(r.rows).toEqual([
      { user_id: "b1", name: "Doco", is_bot: true },
      { user_id: "u1", name: "Tania Z.", is_bot: false },
    ]);
  });
});

describe("the schema", () => {
  it("keeps a mirror Doco private, and only mirrors into a private Doco", async () => {
    await expect(
      dbm.db.query("UPDATE docos SET visibility = 'public' WHERE id = 'doco_notion'"),
    ).rejects.toThrow(/must stay private/);
    await expect(
      dbm.db.query(
        `INSERT INTO notion_mirrors (doco_id, workspace_id, bot_id, access_token, consented_at)
         VALUES ('doco_public', 'w2', 'bot-2', 'v1:enc', now())`,
      ),
    ).rejects.toThrow(/private Doco/);
  });

  it("feeds one mirror per Notion workspace", async () => {
    await dbm.db.query(
      `INSERT INTO docos (id, handle, owner_id, workspace_id, data)
       VALUES ('doco_other', 'acme-other', 'workspace_1', 'workspace_1', '{}'::jsonb)`,
    );
    await expect(
      dbm.db.query(
        `INSERT INTO notion_mirrors (doco_id, workspace_id, bot_id, access_token, consented_at)
         VALUES ('doco_other', '${WORKSPACE}', 'bot-3', 'v1:enc', now())`,
      ),
    ).rejects.toThrow(/notion_mirrors_workspace_id_key/);
  });

  it("deletes the whole copy with the mirror", async () => {
    await upsertNotionUsers("doco_notion", [{ id: "u1", type: "person", name: "Tania" }]);
    await dbm.db.query("DELETE FROM notion_mirrors WHERE doco_id = 'doco_notion'");

    for (const table of ["notion_pages", "notion_links", "notion_users"]) {
      const r = await dbm.db.query(`SELECT 1 FROM ${table}`);
      expect(r.rows, table).toHaveLength(0);
    }
  });
});
