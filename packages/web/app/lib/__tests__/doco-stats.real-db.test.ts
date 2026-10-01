// A Doco that copies from a source (a codebase, a Slack or a Notion workspace)
// holds what it copied in that source's own table, not as nodes. The Doco list
// counts those copies and dates the Doco by the latest one. PGlite runs the
// real schema.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(state.db),
}));

import { listDocoStats } from "../doco-stats.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

beforeEach(async () => {
  state.db = new PGlite({ extensions: { vector } });
  await state.db.exec(schemaSql);
  await state.db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'torre', 'Torre');
    INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
      ('doco_code', 'torre-codebase', 'workspace_1', 'workspace_1', 'private', '{"template_handle": "codebase"}'),
      ('doco_slack', 'torre-slack', 'workspace_1', 'workspace_1', 'private', '{"template_handle": "slack"}'),
      ('doco_notion', 'torre-notion', 'workspace_1', 'workspace_1', 'private', '{"template_handle": "notion"}'),
      ('doco_plain', 'torre-ideas', 'workspace_1', 'workspace_1', 'private', '{}');
    INSERT INTO code_files (doco_id, repo, path, sha, size, synced_at) VALUES
      ('doco_code', 'torre/app', 'a.ts', 's1', 1, '2026-09-24T00:00:00Z'),
      ('doco_code', 'torre/app', 'b.ts', 's2', 1, '2026-09-25T00:00:00Z');
    INSERT INTO group_chat_installations (id, provider, workspace_id, workspace_name, doco_workspace_id)
      VALUES ('gci_1', 'slack', 'T1', 'Torre', 'workspace_1');
    INSERT INTO group_chat_mirrors (doco_id, installation_id, team_domain, history_since, consented_at)
      VALUES ('doco_slack', 'gci_1', 'torre', '2020-09-27T00:00:00Z', now());
    INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at, excluded, archived) VALUES
      ('doco_slack', 'C_GEN', 'general', now(), false, false),
      ('doco_slack', 'C_HID', 'hidden', now(), true, false);
    INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at) VALUES
      ('doco_slack', 'C_GEN', '1.1', 'older', '2026-09-20T00:00:00Z'),
      ('doco_slack', 'C_GEN', '1.2', 'newer', '2026-09-21T00:00:00Z'),
      ('doco_slack', 'C_HID', '1.3', 'excluded', '2026-09-29T00:00:00Z');
    INSERT INTO notion_mirrors (doco_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
      VALUES ('doco_notion', 'ws-1', 'Torre', 'bot-1', 'v1:enc', now());
    INSERT INTO notion_pages (doco_id, page_id, object, url, synced_at) VALUES
      ('doco_notion', 'p1', 'page', 'https://www.notion.so/p1', '2026-09-22T00:00:00Z'),
      ('doco_notion', 'p2', 'data_source', 'https://www.notion.so/p2', '2026-09-23T00:00:00Z'),
      ('doco_notion', 'p3', 'page', 'https://www.notion.so/p3', NULL);
  `);
});

const iso = (at: string | null | undefined) => (at ? new Date(at).toISOString() : at);

describe("listDocoStats copies", () => {
  it("counts what each Doco copied and dates it by the latest copy", async () => {
    const stats = await listDocoStats(["doco_code", "doco_slack", "doco_notion", "doco_plain"]);
    const seen = (id: string) => {
      const s = stats.get(id);
      return { nodes: s?.nodes, copied: s?.copied, lastUpdatedAt: iso(s?.lastUpdatedAt) };
    };
    expect(seen("doco_code")).toEqual({
      nodes: 0,
      copied: { count: 2, unit: "file" },
      lastUpdatedAt: "2026-09-25T00:00:00.000Z",
    });
    // Messages of a channel left out of the copy aren't counted.
    expect(seen("doco_slack")).toEqual({
      nodes: 0,
      copied: { count: 2, unit: "message" },
      lastUpdatedAt: "2026-09-21T00:00:00.000Z",
    });
    // A page not fetched yet isn't copied.
    expect(seen("doco_notion")).toEqual({
      nodes: 0,
      copied: { count: 2, unit: "page" },
      lastUpdatedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(seen("doco_plain")).toEqual({ nodes: 0, copied: null, lastUpdatedAt: null });
  });
});
