// The Doco list counts each Doco by the one thing it holds: a Doco that imports
// from a source (a codebase, a Slack or a Notion workspace) by what it
// imported, which lives in that source's own table, not as nodes; a process Doco by its
// processes; every other kind by its nodes of one type, or all its nodes when
// it has no known template. PGlite runs the real schema.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(state.db),
}));

import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { listDocoStats } from "../doco-stats.server";

beforeEach(async () => {
  state.db = await freshDb();
  await state.db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'torre', 'Torre');
    INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
      ('doco_code', 'torre-codebase', 'workspace_1', 'workspace_1', 'private', '{"template_handle": "codebase"}'),
      ('doco_slack', 'torre-slack', 'workspace_1', 'workspace_1', 'private', '{"template_handle": "slack"}'),
      ('doco_notion', 'torre-notion', 'workspace_1', 'workspace_1', 'private', '{"template_handle": "notion"}'),
      ('doco_plain', 'torre-ideas', 'workspace_1', 'workspace_1', 'private', '{}'),
      ('doco_prs', 'torre-prs', 'workspace_1', 'workspace_1', 'private', '{"template_handle": "github-pull-requests"}'),
      ('doco_flow', 'torre-processes', 'workspace_1', 'workspace_1', 'private', '{"template_handle": "process"}'),
      ('doco_misc', 'torre-notes', 'workspace_1', 'workspace_1', 'private', '{}');
    INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, updated_at) VALUES
      ('reference_1', 'doco_prs', 'reference', 'active', 'Merged PR', '2026-09-20T00:00:00Z'),
      ('reference_2', 'doco_prs', 'reference', 'retired', 'Closed PR', '2026-09-21T00:00:00Z'),
      ('principal_1', 'doco_prs', 'principal', 'active', 'Reviewer', '2026-09-22T00:00:00Z'),
      ('action_hire', 'doco_flow', 'action', 'active', 'Hire', '2026-09-20T00:00:00Z'),
      ('action_screen', 'doco_flow', 'action', 'active', 'Screen', '2026-09-20T00:00:00Z'),
      ('action_offer', 'doco_flow', 'action', 'active', 'Make an offer', '2026-09-20T00:00:00Z'),
      ('action_pay', 'doco_flow', 'action', 'active', 'Agree on pay', '2026-09-20T00:00:00Z'),
      ('decision_fit', 'doco_flow', 'decision', 'active', 'Fit?', '2026-09-20T00:00:00Z'),
      ('action_lone', 'doco_flow', 'action', 'drafting', 'Sketch', '2026-09-20T00:00:00Z'),
      ('idea_1', 'doco_misc', 'idea', 'active', 'An idea', '2026-09-20T00:00:00Z'),
      ('decision_1', 'doco_misc', 'decision', 'retired', 'A decision', '2026-09-20T00:00:00Z');
    INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type) VALUES
      ('edge_1', 'doco_flow', 'has_parent', 'action_screen', 'action', 'action_hire', 'action'),
      ('edge_2', 'doco_flow', 'has_parent', 'action_offer', 'action', 'action_hire', 'action'),
      ('edge_3', 'doco_flow', 'has_parent', 'action_pay', 'action', 'action_offer', 'action'),
      ('edge_4', 'doco_flow', 'has_parent', 'decision_fit', 'decision', 'action_screen', 'action');
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
    INSERT INTO notion_pages (doco_id, page_id, object, url, last_edited_time, synced_at) VALUES
      ('doco_notion', 'p1', 'page', 'https://www.notion.so/p1', '2026-09-22T05:00:00Z', '2026-09-30T00:00:00Z'),
      ('doco_notion', 'p2', 'data_source', 'https://www.notion.so/p2', '2026-09-23T00:00:00Z', '2026-09-30T00:00:00Z'),
      ('doco_notion', 'p3', 'page', 'https://www.notion.so/p3', '2026-09-26T00:00:00Z', NULL);
  `);
});

const iso = (at: string | null | undefined) => (at ? new Date(at).toISOString() : at);

describe("listDocoStats", () => {
  it("counts each Doco by the one thing it holds and dates it by the latest change", async () => {
    const stats = await listDocoStats([
      "doco_code",
      "doco_slack",
      "doco_notion",
      "doco_plain",
      "doco_prs",
      "doco_flow",
      "doco_misc",
    ]);
    const seen = (id: string) => {
      const s = stats.get(id);
      return { items: s?.items, lastUpdatedAt: iso(s?.lastUpdatedAt) };
    };
    expect(seen("doco_code")).toEqual({ items: 2, lastUpdatedAt: "2026-09-25T00:00:00.000Z" });
    // Messages of a channel left out of the copy aren't counted.
    expect(seen("doco_slack")).toEqual({ items: 2, lastUpdatedAt: "2026-09-21T00:00:00.000Z" });
    // A page not fetched yet isn't imported; a page dates from its last edit in Notion.
    expect(seen("doco_notion")).toEqual({ items: 2, lastUpdatedAt: "2026-09-23T00:00:00.000Z" });
    expect(seen("doco_plain")).toEqual({ items: 0, lastUpdatedAt: null });
    // Pull requests are its References, closed ones too; its reviewer is not one.
    expect(seen("doco_prs")).toEqual({ items: 2, lastUpdatedAt: "2026-09-22T00:00:00.000Z" });
    // A process is an Action with child Actions: Hire, and Make an offer under it.
    // A gateway under Screen doesn't make Screen one, nor does a lone Action.
    expect(seen("doco_flow")).toEqual({ items: 2, lastUpdatedAt: "2026-09-20T00:00:00.000Z" });
    // With no known template, every node counts.
    expect(seen("doco_misc")).toEqual({ items: 2, lastUpdatedAt: "2026-09-20T00:00:00.000Z" });
  });
});
