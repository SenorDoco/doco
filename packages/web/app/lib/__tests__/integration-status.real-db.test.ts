// What an integrated Doco reports about each source it copies from: how live
// the copy is (the newest item copied) and how far the import of older items
// has got. PGlite runs the real schema.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { loadIntegrationStatuses } from "../integration-status.server";

type Client = Parameters<typeof loadIntegrationStatuses>[0];
let db: PGlite;
let c: Client;

const NOW = new Date("2026-09-27T15:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const iso = (ts: number) => new Date(ts * 1000).toISOString();

beforeEach(async () => {
  db = await freshDb();
  c = db as unknown as Client;
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'torre', 'Torre');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_slack', 'torre-slack', 'workspace_1', 'workspace_1', '{}'::jsonb),
      ('doco_gh', 'torre-prs', 'workspace_1', 'workspace_1', '{}'::jsonb),
      ('doco_notion', 'torre-notion', 'workspace_1', 'workspace_1', '{}'::jsonb),
      ('doco_plain', 'torre-doco', 'workspace_1', 'workspace_1', '{}'::jsonb);
    INSERT INTO notion_mirrors (doco_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
      VALUES ('doco_notion', 'ws-1', 'Torre', 'bot-1', 'v1:enc', '${minutesAgo(60)}');
    INSERT INTO notion_pages (doco_id, page_id, object, url, last_edited_time, fetch_pending, synced_at) VALUES
      ('doco_notion', 'p1', 'page', 'https://www.notion.so/p1', '${minutesAgo(30)}', false, now()),
      ('doco_notion', 'p2', 'page', 'https://www.notion.so/p2', '${minutesAgo(3)}', false, now()),
      ('doco_notion', 'p3', 'page', 'https://www.notion.so/p3', '${minutesAgo(1)}', true, NULL);
    INSERT INTO group_chat_installations (id, provider, workspace_id, workspace_name, doco_workspace_id)
      VALUES ('gci_1', 'slack', 'T1', 'Torre', 'workspace_1');
    INSERT INTO group_chat_mirrors (doco_id, installation_id, team_domain, history_since, consented_at)
      VALUES ('doco_slack', 'gci_1', 'torre', '2020-09-27T00:00:00Z', '${minutesAgo(60)}');
    INSERT INTO group_chat_channels
      (doco_id, channel_id, name, joined_at, excluded, archived, history_oldest_ts, history_done_at) VALUES
      ('doco_slack', 'C_GEN', 'general', now(), false, false, '1600000000.000100', now()),
      ('doco_slack', 'C_ENG', 'eng', now(), false, false, '1735689600.000100', NULL),
      ('doco_slack', 'C_OLD', 'old', NULL, false, true, NULL, NULL),
      ('doco_slack', 'C_HID', 'hidden', now(), true, false, NULL, NULL);
    INSERT INTO group_chat_messages (doco_id, channel_id, ts, thread_ts, reply_count, text, posted_at) VALUES
      ('doco_slack', 'C_GEN', '1790000000.000100', NULL, 0, 'newest', to_timestamp(1790000000)),
      ('doco_slack', 'C_ENG', '1780000000.000100', '1780000000.000100', 3, 'a thread', to_timestamp(1780000000)),
      ('doco_slack', 'C_HID', '1799999999.000100', NULL, 0, 'excluded', to_timestamp(1799999999));
  `);
});

async function setSlackHeartbeat(minutes: number | null) {
  await db.query(
    "UPDATE group_chat_mirrors SET history_next_at = $1 WHERE doco_id = 'doco_slack'",
    [minutes === null ? null : minutesAgo(minutes)],
  );
}

async function setGitHub(integration: unknown) {
  await db.query(
    "UPDATE docos SET data = jsonb_build_object('github_integration', $1::jsonb) WHERE id = 'doco_gh'",
    [JSON.stringify(integration)],
  );
}

describe("loadIntegrationStatuses", () => {
  it("is empty for a Doco that copies from nothing", async () => {
    expect(await loadIntegrationStatuses(c, "doco_plain", NOW)).toEqual([]);
  });

  // A Doco made to fill from a source stays empty until someone connects it:
  // its home says so instead of looking like an import that never starts.
  describe("a Doco whose source isn't connected yet", () => {
    beforeEach(async () => {
      await db.exec(`
        INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
          ('doco_code', 'torre-codebase', 'workspace_1', 'workspace_1', '{"template_handle": "codebase"}'),
          ('doco_issues', 'torre-github-issues', 'workspace_1', 'workspace_1', '{"template_handle": "github-issues"}'),
          ('doco_chat', 'torre-chat', 'workspace_1', 'workspace_1', '{"template_handle": "slack"}'),
          ('doco_wiki', 'torre-wiki', 'workspace_1', 'workspace_1', '{"template_handle": "notion"}');
      `);
    });

    it("reports the source its template fills from as not connected", async () => {
      for (const [id, integration] of [
        ["doco_code", "github"],
        ["doco_issues", "github"],
        ["doco_chat", "slack"],
        ["doco_wiki", "notion"],
      ]) {
        expect(await loadIntegrationStatuses(c, id, NOW), id).toEqual([
          { integration, state: "unconnected" },
        ]);
      }
    });

    it("reports the import instead once a repository is connected", async () => {
      await db.exec(`
        UPDATE docos SET data = data || '{"github_integration": {"connections":
          [{"repo": "acme/store", "installation_id": 7}],
          "backfill": {"status": "running", "repos": 1, "repo_index": 0, "cursor_at": "${minutesAgo(1)}"}}}'
        WHERE id = 'doco_code';
      `);
      expect(await loadIntegrationStatuses(c, "doco_code", NOW)).toEqual([
        expect.objectContaining({ integration: "github", state: "importing", repos: 1 }),
      ]);
    });
  });

  describe("Slack", () => {
    it("reports the newest message and how far back every channel is copied", async () => {
      await setSlackHeartbeat(0);

      expect(await loadIntegrationStatuses(c, "doco_slack", NOW)).toEqual([
        {
          integration: "slack",
          teamName: "Torre",
          latestAt: iso(1790000000),
          state: "importing",
          backTo: iso(1735689600.0001),
          since: "2020-09-27T00:00:00.000Z",
          channelsDone: 1,
          channels: 2,
          threadsPending: 1,
        },
      ]);
    });

    it("hasn't a date to report while a channel's history hasn't started", async () => {
      await setSlackHeartbeat(0);
      await db.exec(
        "UPDATE group_chat_channels SET joined_at = NULL, archived = false WHERE channel_id = 'C_OLD'",
      );

      const [slack] = await loadIntegrationStatuses(c, "doco_slack", NOW);
      expect(slack).toMatchObject({ backTo: null, channels: 3, state: "importing" });
    });

    it("is stalled when the sync hasn't run for a while", async () => {
      await setSlackHeartbeat(20);
      expect((await loadIntegrationStatuses(c, "doco_slack", NOW))[0]).toMatchObject({
        state: "stalled",
      });
    });

    it("is stalled when the sync never ran since it was turned on", async () => {
      await setSlackHeartbeat(null);
      expect((await loadIntegrationStatuses(c, "doco_slack", NOW))[0]).toMatchObject({
        state: "stalled",
      });
    });

    it("is done once every channel and thread is copied", async () => {
      await setSlackHeartbeat(20);
      await db.exec(`
        UPDATE group_chat_channels SET history_done_at = now() WHERE channel_id = 'C_ENG';
        UPDATE group_chat_messages SET replies_synced_at = now();
      `);

      expect((await loadIntegrationStatuses(c, "doco_slack", NOW))[0]).toMatchObject({
        state: "done",
        channelsDone: 2,
        channels: 2,
        threadsPending: 0,
      });
    });
  });

  describe("Notion", () => {
    async function setNotion(fields: string) {
      await db.query(`UPDATE notion_mirrors SET ${fields} WHERE doco_id = 'doco_notion'`);
    }

    it("reports the newest copied page's edit and how many pages are copied", async () => {
      await setNotion(`ticked_at = '${minutesAgo(1)}'`);

      expect(await loadIntegrationStatuses(c, "doco_notion", NOW)).toEqual([
        {
          integration: "notion",
          workspaceName: "Torre",
          latestAt: minutesAgo(3),
          state: "importing",
          needsReauth: false,
          pagesDone: 2,
          pages: 3,
          listingCapped: false,
        },
      ]);
    });

    it("is stalled when the sync hasn't run for a while, or never since consent", async () => {
      await setNotion(`ticked_at = '${minutesAgo(20)}'`);
      expect((await loadIntegrationStatuses(c, "doco_notion", NOW))[0]).toMatchObject({
        state: "stalled",
      });
      await setNotion("ticked_at = NULL");
      expect((await loadIntegrationStatuses(c, "doco_notion", NOW))[0]).toMatchObject({
        state: "stalled",
      });
    });

    it("is stalled, and says so, when Notion no longer accepts the token", async () => {
      await setNotion(`ticked_at = '${minutesAgo(1)}', needs_reauth_at = now()`);
      expect((await loadIntegrationStatuses(c, "doco_notion", NOW))[0]).toMatchObject({
        state: "stalled",
        needsReauth: true,
      });
    });

    it("is done once a discovery walk finished and nothing is waiting", async () => {
      await setNotion(`ticked_at = '${minutesAgo(30)}', discovered_at = now()`);
      await db.query("UPDATE notion_pages SET fetch_pending = false, synced_at = now()");
      expect((await loadIntegrationStatuses(c, "doco_notion", NOW))[0]).toMatchObject({
        state: "done",
        pagesDone: 3,
        pages: 3,
      });
    });
  });

  describe("GitHub", () => {
    beforeEach(async () => {
      await db.exec(`
        INSERT INTO nodes (id, doco_id, node_type, locator, updated_at) VALUES
          ('reference_1', 'doco_gh', 'reference', 'https://github.com/acme/store/pull/1', '${minutesAgo(90)}'),
          ('reference_2', 'doco_gh', 'reference', 'https://github.com/acme/store/pull/2', '${minutesAgo(5)}'),
          ('reference_3', 'doco_gh', 'reference', 'https://example.com/spec', '${minutesAgo(1)}'),
          ('eval_1', 'doco_gh', 'eval', 'packages/web/app/x.test.ts:12', '${minutesAgo(1)}');
      `);
    });

    it("reports the latest PR change and the old-PR import's progress", async () => {
      await setGitHub({
        connections: [{ repo: "acme/store", installation_id: 7 }],
        backfill: { status: "running", repos: 4, repo_index: 1, cursor_at: minutesAgo(1) },
      });

      expect(await loadIntegrationStatuses(c, "doco_gh", NOW)).toEqual([
        {
          integration: "github",
          item: "pull request",
          items: "pull requests",
          latestAt: minutesAgo(5),
          state: "importing",
          reposDone: 1,
          repos: 4,
          skipped: 0,
          refused: false,
          permission: "Pull requests",
        },
      ]);
    });

    it("speaks of the issues a GitHub issues Doco brings, dated by the latest issue change", async () => {
      await setGitHub({ connections: [{ repo: "acme/store", installation_id: 7 }] });
      await db.exec(`
        UPDATE docos SET data = data || '{"template_handle": "github-issues"}' WHERE id = 'doco_gh';
        INSERT INTO nodes (id, doco_id, node_type, locator, updated_at) VALUES
          ('eval_2', 'doco_gh', 'eval', 'https://github.com/acme/store/issues/9', '${minutesAgo(2)}');
      `);
      expect((await loadIntegrationStatuses(c, "doco_gh", NOW))[0]).toMatchObject({
        item: "issue",
        items: "issues",
        latestAt: minutesAgo(2),
      });
    });

    it("speaks of the files a codebase Doco copies, dated by the latest file copied", async () => {
      await setGitHub({ connections: [{ repo: "acme/store", installation_id: 7 }] });
      await db.exec(`
        UPDATE docos SET data = data || '{"template_handle": "codebase"}', visibility = 'private'
         WHERE id = 'doco_gh';
        INSERT INTO code_files (doco_id, repo, path, sha, size, synced_at) VALUES
          ('doco_gh', 'acme/store', 'a.ts', 's1', 1, '${minutesAgo(3)}'),
          ('doco_gh', 'acme/store', 'b.ts', 's2', 1, '${minutesAgo(30)}');
      `);
      expect((await loadIntegrationStatuses(c, "doco_gh", NOW))[0]).toMatchObject({
        item: "file",
        items: "files",
        latestAt: minutesAgo(3),
      });
    });

    it("is stalled when the import stopped advancing", async () => {
      await setGitHub({
        connections: [{ repo: "acme/store", installation_id: 7 }],
        backfill: { status: "running", repos: 4, repo_index: 1, cursor_at: minutesAgo(60) },
      });
      expect((await loadIntegrationStatuses(c, "doco_gh", NOW))[0]).toMatchObject({
        state: "stalled",
      });
    });

    it("is done once the import finished, or when there was nothing to import", async () => {
      await setGitHub({
        connections: [{ repo: "acme/store", installation_id: 7 }],
        backfill: { status: "done", repos: 4, repo_index: 4 },
      });
      expect((await loadIntegrationStatuses(c, "doco_gh", NOW))[0]).toMatchObject({
        state: "done",
      });

      await setGitHub({ installations: [{ installation_id: 7, account: "acme" }] });
      expect((await loadIntegrationStatuses(c, "doco_gh", NOW))[0]).toMatchObject({
        state: "done",
      });
    });
  });
});
