// Real-database exercise of the three activity logs: writes (`changesets`),
// queries (`query_events`) and imports (what integrations brought). Over a
// period, each log has a total and a top list: Top contributors and Top
// queryers give one row per person and the agent they worked through (or the
// website), so one person can appear once per agent, and Top integrations one
// row per integration. The Activity calendars count each log per day.

import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import {
  countByDay,
  loadLatestActivity,
  rollUpActivity,
  summarizeActivity,
} from "../activity-log.server";

let db: InstanceType<typeof PGlite>;

const CLAUDE_CODE = { auth: "oauth", token_name: "Claude Code", client_name: "claude-code" };
const WEBSITE = { surface: "website" };
const SEPTEMBER = { since: "2026-09-01T00:00:00Z", until: "2026-10-01T00:00:00Z" };
const BOTH = { docoIds: ["doco_notes", "doco_bugs"] };

async function write(
  actor: string | null,
  docoId: string,
  source: string,
  metadata: Record<string, unknown> | null,
  at: string,
) {
  await db.query(
    "INSERT INTO changesets (doco_id, actor, source, metadata, recorded_at) VALUES ($1, $2, $3, $4, $5)",
    [docoId, actor, source, metadata ? JSON.stringify(metadata) : null, at],
  );
}

/** A change to one of the Doco's settings (a policy), not to its content. */
async function writePolicy(docoId: string, at: string) {
  const { rows } = await db.query<{ tx_id: number }>(
    `INSERT INTO changesets (doco_id, actor, source, metadata, recorded_at)
     VALUES ($1, 'user_alice', 'ui', '{"surface": "website"}', $2) RETURNING tx_id`,
    [docoId, at],
  );
  await db.query(
    `INSERT INTO node_versions (entity_id, entity_type, version, op, payload, tx_id)
     VALUES ($1, 'policy', 1, 'create', '{}', $2)`,
    [`policy_${rows[0].tx_id}`, rows[0].tx_id],
  );
}

async function query(
  actor: string | null,
  docoId: string | null,
  source: string,
  metadata: Record<string, unknown> | null,
  at: string,
) {
  await db.query(
    `INSERT INTO query_events (actor, workspace_id, doco_id, source, metadata, at)
     VALUES ($1, 'workspace_acme', $2, $3, $4, $5)`,
    [actor, docoId, source, metadata ? JSON.stringify(metadata) : null, at],
  );
}

beforeEach(async () => {
  db = await freshDb();
  await db.query(
    `INSERT INTO users (id, github_login, data) VALUES
       ('user_alice', 'alice', '{}'::jsonb),
       ('user_bob', 'bob', '{}'::jsonb)`,
  );
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme')",
  );
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
       ('doco_notes', 'acme-notes', 'workspace_acme', 'workspace_acme', '{}'::jsonb),
       ('doco_bugs', 'acme-bugs', 'workspace_acme', 'workspace_acme', '{}'::jsonb)`,
  );
});

/** What each integration brought into the Notes Doco: a GitHub code file and
 *  pull request, a Slack message (and one from a channel left out of the
 *  copy), and two Notion pages (one not fetched yet). */
async function imports() {
  await db.exec(`
    INSERT INTO code_files (doco_id, repo, path, sha, size, synced_at)
      VALUES ('doco_notes', 'acme/app', 'a.ts', 's1', 1, '2026-09-02T08:00:00Z');
    INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, locator, updated_at)
      VALUES ('reference_1', 'doco_notes', 'reference', 'active', 'Add login',
              'https://github.com/acme/app/pull/7', '2026-09-03T08:00:00Z');
    INSERT INTO group_chat_installations (id, provider, workspace_id, workspace_name, doco_workspace_id)
      VALUES ('gci_1', 'slack', 'T1', 'Acme', 'workspace_acme');
    INSERT INTO group_chat_mirrors (doco_id, installation_id, team_domain, history_since, consented_at)
      VALUES ('doco_notes', 'gci_1', 'acme', '2020-01-01T00:00:00Z', now());
    INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at, excluded, archived) VALUES
      ('doco_notes', 'C_GEN', 'general', now(), false, false),
      ('doco_notes', 'C_HID', 'hidden', now(), true, false);
    INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at) VALUES
      ('doco_notes', 'C_GEN', '1.1', 'hello', '2026-09-03T09:00:00Z'),
      ('doco_notes', 'C_HID', '1.2', 'left out', '2026-09-03T09:00:00Z');
    INSERT INTO notion_mirrors (doco_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
      VALUES ('doco_notes', 'ws-1', 'Acme', 'bot-1', 'v1:enc', now());
    INSERT INTO notion_pages (doco_id, page_id, object, url, last_edited_time, synced_at) VALUES
      ('doco_notes', 'p1', 'page', 'https://www.notion.so/p1', '2026-09-04T09:00:00Z', now()),
      ('doco_notes', 'p2', 'page', 'https://www.notion.so/p2', '2026-09-04T09:00:00Z', NULL);
  `);
}

describe("summarizeActivity writes", () => {
  it("lists each person once per agent, with the website marked, and leaves imports out", async () => {
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-02T10:00:00Z");
    await write("user_alice", "doco_bugs", "api", CLAUDE_CODE, "2026-09-03T10:00:00Z");
    await write("user_alice", "doco_notes", "ui", WEBSITE, "2026-09-04T10:00:00Z");
    // What the GitHub import recorded: an import, not a write.
    await write("user_bob", "doco_notes", "api", null, "2026-09-05T10:00:00Z");
    await write("user_bob", "doco_notes", "api", null, "2026-09-06T10:00:00Z");
    // A write with no person behind it: counted, but nobody to list.
    await write(null, "doco_notes", "api", { auth: "bearer" }, "2026-09-07T10:00:00Z");

    const summary = await summarizeActivity(db, BOTH, SEPTEMBER, 10);
    expect(summary.writes).toBe(5);
    expect(summary.topContributors).toEqual([
      {
        userId: "user_alice",
        username: "alice",
        via: "Claude Code",
        count: 3,
        lastAt: "2026-09-03T10:00:00.000Z",
      },
      {
        userId: "user_alice",
        username: "alice",
        via: null,
        count: 1,
        lastAt: "2026-09-04T10:00:00.000Z",
      },
    ]);
  });

  it("merges credentials that carry the same agent name", async () => {
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await write(
      "user_alice",
      "doco_notes",
      "api",
      { auth: "oauth", token_name: "Claude Code", client_name: "claude-code-laptop" },
      "2026-09-02T10:00:00Z",
    );
    const { topContributors } = await summarizeActivity(db, BOTH, SEPTEMBER, 10);
    expect(topContributors).toEqual([
      {
        userId: "user_alice",
        username: "alice",
        via: "Claude Code",
        count: 2,
        lastAt: "2026-09-02T10:00:00.000Z",
      },
    ]);
  });

  it("leaves out changes to a Doco's settings", async () => {
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await writePolicy("doco_notes", "2026-09-02T10:00:00Z");
    const summary = await summarizeActivity(db, BOTH, SEPTEMBER, 10);
    expect(summary.writes).toBe(1);
    expect(summary.topContributors.map((a) => [a.username, a.count])).toEqual([["alice", 1]]);
  });

  it("keeps to the Docos, the period and the limit asked for", async () => {
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await write("user_bob", "doco_bugs", "ui", WEBSITE, "2026-09-02T10:00:00Z");
    await write("user_bob", "doco_bugs", "ui", WEBSITE, "2026-09-03T10:00:00Z");
    // Before the period, and at its end.
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-08-31T23:59:59Z");
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-10-01T00:00:00Z");

    const notes = await summarizeActivity(db, { docoIds: ["doco_notes"] }, SEPTEMBER, 10);
    expect(notes.writes).toBe(1);
    expect(notes.topContributors.map((a) => a.username)).toEqual(["alice"]);
    const top = await summarizeActivity(db, BOTH, SEPTEMBER, 1);
    expect(top.writes).toBe(3);
    expect(top.topContributors.map((a) => a.username)).toEqual(["bob"]);
  });
});

describe("summarizeActivity queries", () => {
  it("counts a workspace's searches only on the workspace", async () => {
    await query("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await query("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-02T10:00:00Z");
    await query("user_alice", null, "ui", WEBSITE, "2026-09-03T10:00:00Z");
    await query(
      "user_bob",
      "doco_bugs",
      "ui",
      { surface: "senor_doco", client: "website" },
      "2026-09-04T10:00:00Z",
    );
    // An anonymous read counts, with nobody to list.
    await query(null, "doco_notes", "api", null, "2026-09-05T10:00:00Z");

    const workspace = await summarizeActivity(
      db,
      { ...BOTH, workspaceId: "workspace_acme" },
      SEPTEMBER,
      10,
    );
    expect(workspace.queries).toBe(5);
    expect(workspace.topQueryers).toEqual([
      {
        userId: "user_alice",
        username: "alice",
        via: "Claude Code",
        count: 2,
        lastAt: "2026-09-02T10:00:00.000Z",
      },
      {
        userId: "user_bob",
        username: "bob",
        via: "Señor Doco on website",
        count: 1,
        lastAt: "2026-09-04T10:00:00.000Z",
      },
      {
        userId: "user_alice",
        username: "alice",
        via: null,
        count: 1,
        lastAt: "2026-09-03T10:00:00.000Z",
      },
    ]);

    const notes = await summarizeActivity(db, { docoIds: ["doco_notes"] }, SEPTEMBER, 10);
    expect(notes.queries).toBe(3);
    expect(notes.topQueryers.map((a) => [a.username, a.via, a.count])).toEqual([
      ["alice", "Claude Code", 2],
    ]);
  });
});

describe("summarizeActivity imports", () => {
  it("counts what each integration brought, one row per integration", async () => {
    await imports();
    const summary = await summarizeActivity(db, BOTH, SEPTEMBER, 10);
    expect(summary.imports).toBe(4);
    expect(summary.topIntegrations).toEqual([
      { integration: "github", name: "GitHub", count: 2, lastAt: "2026-09-03T08:00:00.000Z" },
      { integration: "notion", name: "Notion", count: 1, lastAt: "2026-09-04T09:00:00.000Z" },
      { integration: "slack", name: "Slack", count: 1, lastAt: "2026-09-03T09:00:00.000Z" },
    ]);
    const bugs = await summarizeActivity(db, { docoIds: ["doco_bugs"] }, SEPTEMBER, 10);
    expect(bugs.imports).toBe(0);
    expect(bugs.topIntegrations).toEqual([]);
  });
});

describe("loadLatestActivity", () => {
  it("gives each Doco the newest change to its content or item its source brought", async () => {
    await imports();
    await db.exec(`
      -- Newer than everything that counts: a message in the channel left out
      -- of the copy, and a Notion page not fetched yet.
      INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at)
        VALUES ('doco_notes', 'C_HID', '1.3', 'still left out', '2026-09-05T09:00:00Z');
      INSERT INTO notion_pages (doco_id, page_id, object, url, last_edited_time, synced_at)
        VALUES ('doco_notes', 'p3', 'page', 'https://www.notion.so/p3', '2026-09-06T09:00:00Z', NULL);
      INSERT INTO audit_events (event_id, at, doco_id, entity_type, entity_id, op) VALUES
        ('ev_bugs', '2026-09-10T00:00:00Z', 'doco_bugs', 'eval', 'eval_1', 'entity.create'),
        ('ev_policy', '2026-09-20T00:00:00Z', 'doco_bugs', 'policy', 'policy_1', 'entity.update');
      INSERT INTO docos (id, handle, owner_id, workspace_id, data)
        VALUES ('doco_quiet', 'quiet', 'workspace_acme', 'workspace_acme', '{}'::jsonb);
    `);
    const latest = await loadLatestActivity(db, ["doco_notes", "doco_bugs", "doco_quiet"]);
    expect(Object.fromEntries(latest)).toEqual({
      doco_notes: "2026-09-04T09:00:00.000Z",
      // A policy edit is a setting, not the Doco's activity.
      doco_bugs: "2026-09-10T00:00:00.000Z",
    });
  });
});

describe("countByDay", () => {
  it("counts writes, queries and imports per day", async () => {
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await write("user_bob", "doco_notes", "ui", WEBSITE, "2026-09-01T18:00:00Z");
    await write(null, "doco_bugs", "api", { auth: "bearer" }, "2026-09-02T10:00:00Z");
    // The GitHub import's own record of what it brought is an import.
    await write("user_bob", "doco_bugs", "api", null, "2026-09-02T10:00:00Z");
    await writePolicy("doco_notes", "2026-09-02T11:00:00Z");
    // Before the window.
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-07-01T10:00:00Z");
    // A Doco outside the scope.
    await db.query(
      "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_other', 'other', 'workspace_acme', 'workspace_acme', '{}'::jsonb)",
    );
    await write("user_alice", "doco_other", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await imports();

    await query("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await query("user_alice", "doco_bugs", "api", CLAUDE_CODE, "2026-09-03T10:00:00Z");
    await query("user_bob", null, "ui", WEBSITE, "2026-09-03T11:00:00Z");

    const since = "2026-08-01T00:00:00Z";
    expect(await countByDay(db, { ...BOTH, workspaceId: "workspace_acme" }, since)).toEqual({
      writes: { "2026-09-01": 2, "2026-09-02": 1 },
      queries: { "2026-09-01": 1, "2026-09-03": 2 },
      // Code files by when they were copied, a pull request by when Doco last
      // wrote it, messages when posted, Notion pages by their last edit.
      imports: { "2026-09-02": 1, "2026-09-03": 2, "2026-09-04": 1 },
    });
    // Without the workspace, its searches across every Doco don't count.
    expect((await countByDay(db, BOTH, since)).queries).toEqual({
      "2026-09-01": 1,
      "2026-09-03": 1,
    });
  });
});

describe("rollUpActivity", () => {
  // The morning of September 6: every day through the 5th is over.
  const SEPT_6 = new Date("2026-09-06T05:00:00Z");
  const SCOPE = { ...BOTH, workspaceId: "workspace_acme" };
  const SINCE = "2026-08-01T00:00:00Z";
  // Starts and ends mid-day, so both ends come from the logs.
  const PERIOD = { since: "2026-09-01T12:00:00Z", until: "2026-09-06T04:00:00Z" };

  async function activity() {
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T14:00:00Z");
    await write("user_bob", "doco_bugs", "ui", WEBSITE, "2026-09-02T10:00:00Z");
    await write(null, "doco_bugs", "api", { auth: "bearer" }, "2026-09-03T10:00:00Z");
    await write("user_bob", "doco_bugs", "api", null, "2026-09-03T11:00:00Z");
    await writePolicy("doco_notes", "2026-09-04T11:00:00Z");
    await write("user_alice", "doco_notes", "ui", WEBSITE, "2026-09-06T03:00:00Z");
    await query(
      "user_alice",
      "doco_notes",
      "api",
      { ...CLAUDE_CODE, brief_id: "b1" },
      "2026-09-02T10:00:00Z",
    );
    await query(
      "user_alice",
      "doco_notes",
      "api",
      { ...CLAUDE_CODE, brief_id: "b2" },
      "2026-09-02T11:00:00Z",
    );
    await query("user_bob", null, "ui", WEBSITE, "2026-09-05T11:00:00Z");
    await query(null, "doco_bugs", "api", null, "2026-09-06T02:00:00Z");
    await imports();
  }

  async function read() {
    return {
      byDay: await countByDay(db, SCOPE, SINCE),
      summary: await summarizeActivity(db, SCOPE, PERIOD, 10),
      notes: await summarizeActivity(db, { docoIds: ["doco_notes"] }, PERIOD, 10),
    };
  }

  it("reads the same before and after the days are rolled up", async () => {
    await activity();
    const before = await read();
    expect(before.byDay.writes).toEqual({
      "2026-09-01": 2,
      "2026-09-02": 1,
      "2026-09-03": 1,
      "2026-09-06": 1,
    });

    expect(await rollUpActivity(db, SEPT_6)).toEqual({ through: "2026-09-05" });
    expect(await read()).toEqual(before);
    // A second run counts nothing twice.
    await rollUpActivity(db, SEPT_6);
    expect(await read()).toEqual(before);
  });

  it("counts a day's writes and queries once, and recounts imports every run", async () => {
    await activity();
    await rollUpActivity(db, SEPT_6);
    const rolled = await countByDay(db, SCOPE, SINCE);

    // Dated into a rolled day: no write is, but the rollup doesn't look again.
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-02T15:00:00Z");
    // A message from the channel's history, copied after its day was rolled,
    // and a code file copied again today.
    await db.exec(`
      INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at)
        VALUES ('doco_notes', 'C_GEN', '1.4', 'from the history', '2026-09-02T09:00:00Z');
      UPDATE code_files SET synced_at = '2026-09-06T04:30:00Z';
    `);
    const now = await countByDay(db, SCOPE, SINCE);
    expect(now.writes).toEqual(rolled.writes);
    expect(now.imports).toEqual({ ...rolled.imports, "2026-09-06": 1 });

    await rollUpActivity(db, SEPT_6);
    const next = await countByDay(db, SCOPE, SINCE);
    expect(next.writes).toEqual(rolled.writes);
    expect(next.imports).toEqual({
      "2026-09-02": 1,
      "2026-09-03": 2,
      "2026-09-04": 1,
      "2026-09-06": 1,
    });
  });

  it("leaves a day to the logs until an hour after it ends", async () => {
    await activity();
    expect(await rollUpActivity(db, new Date("2026-09-06T00:30:00Z"))).toEqual({
      through: "2026-09-04",
    });
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-05T23:59:00Z");
    expect((await countByDay(db, SCOPE, SINCE)).writes["2026-09-05"]).toBe(1);
  });
});
