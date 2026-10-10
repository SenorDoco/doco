// What the front page's stories are picked from, against a real database: the
// records people and their agents added to a workspace's Docos in the period,
// with what the score reads (whether a record replaced an earlier one, how
// many records link to it, how often briefs served it). Chat Logs, principals,
// what the GitHub import brought, retired records and other workspaces' are
// left out. PGlite backs every query; the model is a stub.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { loadCandidates, rankStories } from "../front-page.server";

let db: PGlite;
// Friday Sep 11, 2026, 00:00 PDT: the daily edition covers Thursday.
const AT = new Date("2026-09-11T07:00:00Z");

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO users (id, github_login, data) VALUES ('user_ana', 'ana', '{}');
    INSERT INTO workspaces (id, handle, name) VALUES
      ('workspace_acme', 'acme', 'Acme'), ('workspace_other', 'other', 'Other');
    INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
      ('doco_notes', 'acme-notes', 'workspace_acme', 'workspace_acme', 'private', '{}'),
      ('doco_gone', 'acme-gone', 'workspace_acme', 'workspace_acme', 'private', '{}'),
      ('doco_else', 'other-notes', 'workspace_other', 'workspace_other', 'private', '{}');
    UPDATE docos SET deleted_at = now() WHERE id = 'doco_gone';
    INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, locator, created_at) VALUES
      ('rule_new', 'doco_notes', 'rule', 'active', 'Ship every task to main.', NULL, '2026-09-10T08:00:00Z'),
      ('decision_new', 'doco_notes', 'decision', 'drafting', 'The digest is daily.', NULL, '2026-09-10T09:00:00Z'),
      ('decision_old', 'doco_notes', 'decision', 'retired', 'The digest is weekly.', NULL, '2026-09-01T09:00:00Z'),
      ('idea_new', 'doco_notes', 'idea', 'active', 'A digest for each Doco.', NULL, '2026-09-10T10:00:00Z'),
      ('idea_dropped', 'doco_notes', 'idea', 'retired', 'Never mind.', NULL, '2026-09-10T10:30:00Z'),
      ('log_chat', 'doco_notes', 'log', 'active', 'Ana chatted with Claude.', NULL, '2026-09-10T11:00:00Z'),
      ('reference_pr', 'doco_notes', 'reference', 'active', 'Add login', 'https://github.com/acme/app/pull/7', '2026-09-10T11:00:00Z'),
      ('reference_doc', 'doco_notes', 'reference', 'active', 'The pricing sheet', 'https://example.com/pricing', '2026-09-10T11:30:00Z'),
      ('decision_late', 'doco_notes', 'decision', 'active', 'After the digest went out.', NULL, '2026-09-11T07:30:00Z'),
      ('decision_gone', 'doco_gone', 'decision', 'active', 'In a deleted Doco.', NULL, '2026-09-10T09:00:00Z'),
      ('decision_else', 'doco_else', 'decision', 'active', 'Another workspace.', NULL, '2026-09-10T09:00:00Z');
    INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type) VALUES
      ('edge_replaces', 'doco_notes', 'replaces', 'decision_new', 'decision', 'decision_old', 'decision'),
      ('edge_supports', 'doco_notes', 'supports', 'reference_doc', 'reference', 'decision_new', 'decision'),
      ('edge_idea', 'doco_notes', 'relates_to', 'idea_new', 'idea', 'decision_new', 'decision');
  `);
  await db.query(
    `INSERT INTO query_events (actor, workspace_id, doco_id, source, metadata, at) VALUES
       ('user_ana', 'workspace_acme', NULL, 'mcp', $1, '2026-09-10T12:00:00Z'),
       ('user_ana', 'workspace_acme', NULL, 'mcp', $1, '2026-09-10T12:30:00Z'),
       ('user_ana', 'workspace_acme', NULL, 'mcp', '{"surface": "website"}', '2026-09-10T12:40:00Z')`,
    [JSON.stringify({ brief_id: "brief_1", served: [{ id: "idea_new", tier: "decided" }] })],
  );
});

describe("loadCandidates", () => {
  it("takes what people and agents added in the period, with what the score reads", async () => {
    const found = await loadCandidates(db, "workspace_acme", "daily", AT);
    expect(Object.fromEntries(found.map((c) => [c.id, [c.replaces, c.links, c.served]]))).toEqual({
      rule_new: [false, 0, 0],
      decision_new: [true, 3, 0],
      idea_new: [false, 1, 2],
      reference_doc: [false, 1, 0],
    });
    expect(found.find((c) => c.id === "decision_new")).toMatchObject({
      docoId: "doco_notes",
      docoHandle: "acme-notes",
      nodeType: "decision",
      prose: "The digest is daily.",
    });
  });

  it("covers the week before for the weekly digest", async () => {
    const found = await loadCandidates(db, "workspace_acme", "weekly", AT);
    expect(found.map((c) => c.id).sort()).toEqual([
      "decision_new",
      "idea_new",
      "reference_doc",
      "rule_new",
    ]);
  });
});

describe("rankStories", () => {
  it("ranks the shortlist with the model's order, headlines and takeaways", async () => {
    const prompts: string[] = [];
    const ranked = await rankStories(
      db,
      "workspace_acme",
      "daily",
      AT,
      "https://doco.test",
      async (prompt) => {
        prompts.push(prompt);
        return [
          {
            id: "idea_new",
            headline: "A Digest per Doco",
            takeaway: "Each Doco could get its own digest.",
          },
          {
            id: "decision_new",
            headline: "Daily Digest",
            takeaway: "The digest now comes every day.",
          },
        ];
      },
    );
    expect(prompts[0]).toContain("[decision_new · decision · acme-notes]\nThe digest is daily.");
    expect(ranked.map((r) => [r.id, r.headline, r.takeaway])).toEqual([
      ["idea_new", "A Digest per Doco", "Each Doco could get its own digest."],
      ["decision_new", "Daily Digest", "The digest now comes every day."],
      ["rule_new", "Ship every task to main.", ""],
      ["reference_doc", "The pricing sheet", ""],
    ]);
    expect(ranked[0].url).toBe("https://doco.test/acme-notes/idea/idea_new");
  });

  it("asks no model when nothing was added", async () => {
    let asked = false;
    const ranked = await rankStories(
      db,
      "workspace_other",
      "daily",
      new Date("2026-09-20T07:00:00Z"),
      "https://doco.test",
      async () => {
        asked = true;
        return [];
      },
    );
    expect(ranked).toEqual([]);
    expect(asked).toBe(false);
  });
});
