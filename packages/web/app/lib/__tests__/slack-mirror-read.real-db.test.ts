// Reading the Slack mirror: the Doco home's Slack perspective (channels →
// messages → threads) and Slack results in the Doco's search. PGlite runs the
// real schema and full-text search.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadSlackPerspective,
  renderSlackText,
  searchSlackMirror,
  slackPermalink,
} from "../slack-mirror-read.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

type Client = Parameters<typeof loadSlackPerspective>[0];
let db: PGlite;
let c: Client;

beforeEach(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  c = db as unknown as Client;
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'acme', 'Acme');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_slack', 'acme-slack', 'workspace_1', 'workspace_1', '{}'::jsonb),
      ('doco_plain', 'acme-notes', 'workspace_1', 'workspace_1', '{}'::jsonb);
    INSERT INTO group_chat_installations (id, provider, workspace_id, doco_workspace_id)
      VALUES ('gci_1', 'slack', 'T1', 'workspace_1');
    INSERT INTO group_chat_mirrors (doco_id, installation_id, team_domain, history_since, consented_at)
      VALUES ('doco_slack', 'gci_1', 'acme', now() - interval '6 years', now());
    INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at, excluded) VALUES
      ('doco_slack', 'C_GEN', 'general', now(), false),
      ('doco_slack', 'C_ENG', 'eng', now(), false),
      ('doco_slack', 'C_HID', 'excluded', now(), true);
    INSERT INTO group_chat_members (doco_id, chat_user_id, display_name, real_name, avatar_url) VALUES
      ('doco_slack', 'U_ANA', 'Ana', 'Ana Ruiz', 'https://a/ana.png'),
      ('doco_slack', 'U_BEN', '', 'Ben Ortiz', NULL);
    INSERT INTO group_chat_messages (doco_id, channel_id, ts, thread_ts, author_id, text, files, posted_at) VALUES
      ('doco_slack', 'C_GEN', '1700000000.000100', NULL, 'U_ANA', 'welcome everyone', '[]', to_timestamp(1700000000)),
      ('doco_slack', 'C_ENG', '1700000100.000100', '1700000100.000100', 'U_ANA',
        'we are hitting the neon connection limit, <@U_BEN> can you look?', '[]', to_timestamp(1700000100)),
      ('doco_slack', 'C_ENG', '1700000200.000100', '1700000100.000100', 'U_BEN',
        'switching the pooler to transaction mode', '[{"name":"pool.png","permalink":"https://acme.slack.com/files/F1"}]', to_timestamp(1700000200)),
      ('doco_slack', 'C_ENG', '1700000300.000100', '1700000100.000100', 'U_ANA', 'thanks, fixed', '[]', to_timestamp(1700000300)),
      ('doco_slack', 'C_ENG', '1700000400.000100', NULL, 'B_BOT', 'deploy finished', '[]', to_timestamp(1700000400));
  `);
});

describe("renderSlackText", () => {
  const names = new Map([["U_ANA", "Ana"]]);

  it.each([
    ["hi <@U_ANA>", "hi @Ana"],
    ["hi <@U_ZED>", "hi @U_ZED"],
    ["see <#C_ENG|eng>", "see #eng"],
    ["<!here> heads up", "@here heads up"],
    ["docs at <https://doco.to|Doco>", "docs at Doco (https://doco.to)"],
    ["raw <https://doco.to>", "raw https://doco.to"],
    ["a &lt;b&gt; &amp; c", "a <b> & c"],
  ])("renders %j as %j", (input, expected) => {
    expect(renderSlackText(input, names)).toBe(expected);
  });
});

describe("slackPermalink", () => {
  it("links a message, and a reply within its thread", () => {
    expect(slackPermalink("acme", "C1", "1700000100.000100", null)).toBe(
      "https://acme.slack.com/archives/C1/p1700000100000100",
    );
    expect(slackPermalink("acme", "C1", "1700000200.000100", "1700000100.000100")).toBe(
      "https://acme.slack.com/archives/C1/p1700000200000100?thread_ts=1700000100.000100&cid=C1",
    );
  });
});

describe("loadSlackPerspective", () => {
  it("lists channels by latest activity, never excluded ones", async () => {
    const data = await loadSlackPerspective(c, "doco_slack", {});

    expect(data.channels.map((ch) => ch.name)).toEqual(["eng", "general"]);
  });

  it("opens the most recently active channel, newest message first, with its thread", async () => {
    const data = await loadSlackPerspective(c, "doco_slack", {});

    expect(data.channelId).toBe("C_ENG");
    expect(data.messages.map((m) => m.ts)).toEqual(["1700000400.000100", "1700000100.000100"]);
    const thread = data.messages[1];
    expect(thread).toMatchObject({
      author: "Ana",
      avatarUrl: "https://a/ana.png",
      text: "we are hitting the neon connection limit, @Ben Ortiz can you look?",
      replyCount: 2,
      permalink: "https://acme.slack.com/archives/C_ENG/p1700000100000100",
    });
    expect(thread.replies.map((r) => [r.author, r.text])).toEqual([
      ["Ben Ortiz", "switching the pooler to transaction mode"],
      ["Ana", "thanks, fixed"],
    ]);
    expect(thread.replies[0].files).toEqual([
      { name: "pool.png", permalink: "https://acme.slack.com/files/F1" },
    ]);
    expect(data.messages[0].author).toBe("B_BOT");
  });

  it("pages to older messages", async () => {
    const first = await loadSlackPerspective(c, "doco_slack", { channelId: "C_ENG", limit: 1 });
    expect(first.messages.map((m) => m.ts)).toEqual(["1700000400.000100"]);
    expect(first.olderBefore).toBe("1700000400.000100");

    const older = await loadSlackPerspective(c, "doco_slack", {
      channelId: "C_ENG",
      limit: 1,
      before: first.olderBefore,
    });
    expect(older.messages.map((m) => m.ts)).toEqual(["1700000100.000100"]);
    expect(older.olderBefore).toBeNull();
  });

  it("searches every channel's messages, replies included", async () => {
    const data = await loadSlackPerspective(c, "doco_slack", { query: "pooler" });

    expect(data.query).toBe("pooler");
    expect(data.messages.map((m) => [m.channelName, m.text])).toEqual([
      ["eng", "switching the pooler to transaction mode"],
    ]);
  });

  it("is empty for a Doco that doesn't mirror Slack", async () => {
    const data = await loadSlackPerspective(c, "doco_plain", {});
    expect(data).toMatchObject({ teamDomain: "", channels: [], messages: [] });
  });
});

describe("searchSlackMirror", () => {
  it("returns matching messages with their author, channel, and Slack link", async () => {
    const hits = await searchSlackMirror(c, "doco_slack", "neon connection", 10);

    expect(hits).toEqual([
      {
        type: "slack_message",
        channel: "eng",
        channel_id: "C_ENG",
        ts: "1700000100.000100",
        thread_ts: "1700000100.000100",
        author: "Ana",
        posted_at: "2023-11-14T22:15:00.000Z",
        text: "we are hitting the neon connection limit, @Ben Ortiz can you look?",
        permalink: "https://acme.slack.com/archives/C_ENG/p1700000100000100",
      },
    ]);
  });

  it("finds nothing in a Doco that doesn't mirror Slack", async () => {
    expect(await searchSlackMirror(c, "doco_plain", "neon", 10)).toEqual([]);
  });
});
