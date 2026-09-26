// Real-DB exercise of turning a Doco into a Slack public-channel mirror:
// recording the mirror, then discovering and joining the team's public
// channels and loading its members. PGlite runs the real schema; Slack's Web
// API is a fake routed by method name.
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
  SlackApiError,
  enableSlackMirror,
  isSlackWorkspaceAdmin,
  loadSlackMirrorStatus,
  setSlackMirrorChannelExcluded,
  stopSlackMirror,
  syncSlackMirrorChannels,
  syncSlackMirrorMembers,
  turnOnSlackMirror,
} from "../slack-mirror-setup.server";

type SlackCall = { method: string; params: URLSearchParams };

/** A fake Slack Web API: `routes[method]` answers each call (paged by cursor). */
function fakeSlack(routes: Record<string, (params: URLSearchParams) => unknown>) {
  const calls: SlackCall[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = url.replace("https://slack.com/api/", "");
    const params = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ method, params });
    const route = routes[method];
    if (!route) return new Response(JSON.stringify({ ok: false, error: "unknown_method" }));
    return new Response(JSON.stringify(route(params)));
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

beforeEach(async () => {
  const db = new PGlite();
  await db.exec(schemaSql);
  dbm.db = db;
  await db.query(
    "INSERT INTO users (id, github_login, data) VALUES ('user_owner', 'owner', '{}'::jsonb)",
  );
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'acme', 'Acme')",
  );
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
       ('doco_slack', 'acme-slack', 'workspace_1', 'workspace_1', 'private', '{}'::jsonb),
       ('doco_public', 'acme-open', 'workspace_1', 'workspace_1', 'public', '{}'::jsonb),
       ('doco_other', 'acme-slack-2', 'workspace_1', 'workspace_1', 'private', '{}'::jsonb)`,
  );
  await db.query(
    `INSERT INTO group_chat_installations (id, provider, workspace_id, doco_workspace_id)
     VALUES ('gci_1', 'slack', 'T1', 'workspace_1')`,
  );
});

const teamInfo = () => ({ ok: true, team: { id: "T1", domain: "acme" } });

async function mirrorRow() {
  const r = await dbm.db.query<{
    installation_id: string;
    team_domain: string;
    consented_by: string;
    history_since: Date;
  }>("SELECT installation_id, team_domain, consented_by, history_since FROM group_chat_mirrors");
  return r.rows;
}

describe("isSlackWorkspaceAdmin", () => {
  it.each([
    [{ is_admin: true }, true],
    [{ is_owner: true }, true],
    [{ is_primary_owner: true }, true],
    [{}, false],
  ])("reads the user's admin flags %j", async (flags, expected) => {
    const slack = fakeSlack({ "users.info": () => ({ ok: true, user: { id: "U1", ...flags } }) });
    expect(await isSlackWorkspaceAdmin("xoxb", "U1", slack.fetchImpl)).toBe(expected);
  });
});

describe("enableSlackMirror", () => {
  it("records the mirror, who authorized it, and a 6-year history floor", async () => {
    const slack = fakeSlack({ "team.info": teamInfo });
    const now = new Date("2026-09-26T00:00:00Z");

    await enableSlackMirror({
      docoId: "doco_slack",
      teamId: "T1",
      consentedBy: "user_owner",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
      now,
    });

    expect(await mirrorRow()).toEqual([
      {
        installation_id: "gci_1",
        team_domain: "acme",
        consented_by: "user_owner",
        history_since: new Date("2020-09-26T00:00:00Z"),
      },
    ]);
  });

  it("refuses to mirror into a public Doco", async () => {
    const slack = fakeSlack({ "team.info": teamInfo });
    await expect(
      enableSlackMirror({
        docoId: "doco_public",
        teamId: "T1",
        consentedBy: "user_owner",
        token: "xoxb",
        fetchImpl: slack.fetchImpl,
      }),
    ).rejects.toThrow(/private/);
    expect(await mirrorRow()).toEqual([]);
  });

  it("refuses a second mirror of the same Slack team", async () => {
    const slack = fakeSlack({ "team.info": teamInfo });
    const args = {
      teamId: "T1",
      consentedBy: "user_owner",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    };
    await enableSlackMirror({ ...args, docoId: "doco_slack" });

    await expect(enableSlackMirror({ ...args, docoId: "doco_other" })).rejects.toThrow(
      /already mirrored into acme-slack/,
    );
  });

  it("keeps a mirror Doco private forever after", async () => {
    const slack = fakeSlack({ "team.info": teamInfo });
    await enableSlackMirror({
      docoId: "doco_slack",
      teamId: "T1",
      consentedBy: "user_owner",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });

    await expect(
      dbm.db.query("UPDATE docos SET visibility = 'public' WHERE id = 'doco_slack'"),
    ).rejects.toThrow(/private/);
  });
});

describe("syncSlackMirrorChannels", () => {
  beforeEach(async () => {
    const slack = fakeSlack({ "team.info": teamInfo });
    await enableSlackMirror({
      docoId: "doco_slack",
      teamId: "T1",
      consentedBy: "user_owner",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });
  });

  function channelList(pages: unknown[][]) {
    return (params: URLSearchParams) => {
      const page = Number(params.get("cursor") || "0");
      return {
        ok: true,
        channels: pages[page],
        response_metadata: { next_cursor: page + 1 < pages.length ? String(page + 1) : "" },
      };
    };
  }

  async function channelRows() {
    const r = await dbm.db.query<{
      channel_id: string;
      name: string;
      joined: boolean;
      excluded: boolean;
    }>(
      `SELECT channel_id, name, joined_at IS NOT NULL AS joined, excluded
         FROM group_chat_channels ORDER BY channel_id`,
    );
    return r.rows;
  }

  it("tracks every public channel across pages and joins the ones the bot isn't in", async () => {
    const slack = fakeSlack({
      "conversations.list": channelList([
        [
          { id: "C1", name: "general", is_member: true, topic: { value: "all hands" } },
          { id: "C2", name: "eng", is_member: false },
        ],
        [{ id: "C3", name: "random", is_member: false }],
      ]),
      "conversations.join": () => ({ ok: true }),
    });

    const result = await syncSlackMirrorChannels({
      docoId: "doco_slack",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });

    expect(result).toEqual({ joined: 2, pending: 0 });
    expect(await channelRows()).toEqual([
      { channel_id: "C1", name: "general", joined: true, excluded: false },
      { channel_id: "C2", name: "eng", joined: true, excluded: false },
      { channel_id: "C3", name: "random", joined: true, excluded: false },
    ]);
    expect(
      slack.calls
        .filter((c) => c.method === "conversations.join")
        .map((c) => c.params.get("channel")),
    ).toEqual(["C2", "C3"]);
    expect(slack.calls.find((c) => c.method === "conversations.list")?.params.get("types")).toBe(
      "public_channel",
    );
  });

  it("never tracks a channel shared with another organization", async () => {
    const slack = fakeSlack({
      "conversations.list": channelList([
        [
          { id: "C1", name: "general", is_member: true },
          { id: "C_EXT", name: "partner-acme", is_member: true, is_ext_shared: true },
          { id: "C_PEND", name: "partner-beta", is_member: false, is_pending_ext_shared: true },
        ],
      ]),
      "conversations.join": () => ({ ok: true }),
    });

    await syncSlackMirrorChannels({
      docoId: "doco_slack",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });

    expect((await channelRows()).map((c) => c.channel_id)).toEqual(["C1"]);
  });

  it("leaves an excluded channel alone", async () => {
    await dbm.db.query(
      "INSERT INTO group_chat_channels (doco_id, channel_id, name, excluded) VALUES ('doco_slack', 'C2', 'eng', true)",
    );
    const slack = fakeSlack({
      "conversations.list": channelList([[{ id: "C2", name: "eng", is_member: false }]]),
      "conversations.join": () => ({ ok: true }),
    });

    await syncSlackMirrorChannels({
      docoId: "doco_slack",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });

    expect(await channelRows()).toEqual([
      { channel_id: "C2", name: "eng", joined: false, excluded: true },
    ]);
    expect(slack.calls.some((c) => c.method === "conversations.join")).toBe(false);
  });

  it("drops a tracked channel that is no longer public (deleted or made private)", async () => {
    await dbm.db.query(
      "INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at) VALUES ('doco_slack', 'C_GONE', 'old', now())",
    );
    const slack = fakeSlack({
      "conversations.list": channelList([[{ id: "C1", name: "general", is_member: true }]]),
    });

    await syncSlackMirrorChannels({
      docoId: "doco_slack",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });

    expect((await channelRows()).map((c) => c.channel_id)).toEqual(["C1"]);
  });

  it("keeps an archived channel's copy but never tries to join it", async () => {
    await dbm.db.query(
      "INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at) VALUES ('doco_slack', 'C_OLD', 'old-project', now())",
    );
    const slack = fakeSlack({
      "conversations.list": channelList([
        [
          { id: "C_OLD", name: "old-project", is_member: true, is_archived: true },
          { id: "C_ARCH", name: "never-joined", is_member: false, is_archived: true },
        ],
      ]),
      "conversations.join": () => ({ ok: true }),
    });

    const result = await syncSlackMirrorChannels({
      docoId: "doco_slack",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });

    expect(result).toEqual({ joined: 0, pending: 0 });
    expect(await channelRows()).toEqual([
      { channel_id: "C_ARCH", name: "never-joined", joined: false, excluded: false },
      { channel_id: "C_OLD", name: "old-project", joined: true, excluded: false },
    ]);
    expect(
      slack.calls.find((c) => c.method === "conversations.list")?.params.get("exclude_archived"),
    ).toBe("false");
    expect(slack.calls.some((c) => c.method === "conversations.join")).toBe(false);
  });

  it("stops joining at the deadline and reports what is left", async () => {
    const slack = fakeSlack({
      "conversations.list": channelList([
        [
          { id: "C1", name: "a", is_member: false },
          { id: "C2", name: "b", is_member: false },
        ],
      ]),
      "conversations.join": () => ({ ok: true }),
    });

    const result = await syncSlackMirrorChannels({
      docoId: "doco_slack",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
      deadline: Date.now() - 1,
    });

    expect(result).toEqual({ joined: 0, pending: 2 });
  });

  it("surfaces Slack's rate limit with its retry delay", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 429, headers: { "Retry-After": "30" } }),
    ) as unknown as typeof fetch;

    const error = await syncSlackMirrorChannels({
      docoId: "doco_slack",
      token: "xoxb",
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ error: "ratelimited", retryAfterMs: 30_000 });
  });
});

describe("syncSlackMirrorMembers", () => {
  it("loads every member across pages", async () => {
    const slack = fakeSlack({
      "team.info": teamInfo,
      "users.list": (params) =>
        params.get("cursor") === "next"
          ? { ok: true, members: [{ id: "U2", name: "ben", is_bot: false }] }
          : {
              ok: true,
              members: [{ id: "U1", name: "ana", profile: { display_name: "Ana" } }],
              response_metadata: { next_cursor: "next" },
            },
    });
    await enableSlackMirror({
      docoId: "doco_slack",
      teamId: "T1",
      consentedBy: "user_owner",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });

    await syncSlackMirrorMembers({
      docoId: "doco_slack",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });

    const r = await dbm.db.query<{ chat_user_id: string; display_name: string }>(
      "SELECT chat_user_id, display_name FROM group_chat_members ORDER BY chat_user_id",
    );
    expect(r.rows).toEqual([
      { chat_user_id: "U1", display_name: "Ana" },
      { chat_user_id: "U2", display_name: "ben" },
    ]);
  });
});

describe("turnOnSlackMirror (after Slack's OAuth round-trip)", () => {
  const adminSlack = (isAdmin: boolean) =>
    fakeSlack({
      "team.info": teamInfo,
      "users.info": () => ({ ok: true, user: { id: "U_OWNER", is_admin: isAdmin } }),
    });

  it("turns the mirror on when a Slack admin authorized it", async () => {
    const slack = adminSlack(true);
    const result = await turnOnSlackMirror({
      docoId: "doco_slack",
      docoWorkspaceId: "workspace_1",
      installerId: "user_owner",
      teamId: "T1",
      authedChatUserId: "U_OWNER",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });

    expect(result).toEqual({ ok: true, handle: "acme-slack" });
    expect(await mirrorRow()).toHaveLength(1);
  });

  it("refuses when the Slack user who approved isn't a Slack admin or owner", async () => {
    const slack = adminSlack(false);
    const result = await turnOnSlackMirror({
      docoId: "doco_slack",
      docoWorkspaceId: "workspace_1",
      installerId: "user_owner",
      teamId: "T1",
      authedChatUserId: "U_OWNER",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "not_slack_admin", handle: "acme-slack" });
    expect(await mirrorRow()).toHaveLength(0);
  });

  it("refuses a Doco outside the Slack team's bound workspace", async () => {
    await dbm.db.query(
      "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_2', 'other', 'Other')",
    );
    const slack = adminSlack(true);
    const result = await turnOnSlackMirror({
      docoId: "doco_slack",
      docoWorkspaceId: "workspace_2",
      installerId: "user_owner",
      teamId: "T1",
      authedChatUserId: "U_OWNER",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "doco_not_found" });
    expect(await mirrorRow()).toHaveLength(0);
  });
});

describe("managing a mirror", () => {
  beforeEach(async () => {
    const slack = fakeSlack({ "team.info": teamInfo });
    await enableSlackMirror({
      docoId: "doco_slack",
      teamId: "T1",
      consentedBy: "user_owner",
      token: "xoxb",
      fetchImpl: slack.fetchImpl,
    });
    await dbm.db.query(
      `INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at) VALUES
         ('doco_slack', 'C1', 'general', now()), ('doco_slack', 'C2', 'eng', now())`,
    );
    await dbm.db.query(
      `INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at) VALUES
         ('doco_slack', 'C1', '1.1', 'hello', now()), ('doco_slack', 'C2', '2.1', 'deploy', now())`,
    );
  });

  it("reports the mirror's channels and copied messages", async () => {
    const status = await loadSlackMirrorStatus("doco_slack");

    expect(status).toMatchObject({
      teamDomain: "acme",
      messageCount: 2,
      threadsPending: 0,
      channels: [
        {
          channelId: "C2",
          name: "eng",
          excluded: false,
          joined: true,
          archived: false,
          messages: 1,
          historyBackTo: null,
          historyDone: false,
        },
        {
          channelId: "C1",
          name: "general",
          excluded: false,
          joined: true,
          archived: false,
          messages: 1,
        },
      ],
    });
    expect(await loadSlackMirrorStatus("doco_other")).toBeNull();
  });

  it("reports how far back each channel's history has been copied", async () => {
    await dbm.db.exec(
      `UPDATE group_chat_channels SET history_oldest_ts = '1600000000.000100' WHERE channel_id = 'C1';
       UPDATE group_chat_channels SET history_done_at = now() WHERE channel_id = 'C2';
       UPDATE group_chat_messages SET reply_count = 2 WHERE channel_id = 'C1'`,
    );

    const status = await loadSlackMirrorStatus("doco_slack");

    expect(status?.threadsPending).toBe(1);
    expect(status?.channels.find((c) => c.channelId === "C1")).toMatchObject({
      historyBackTo: "2020-09-13T12:26:40.000Z",
      historyDone: false,
    });
    expect(status?.channels.find((c) => c.channelId === "C2")).toMatchObject({ historyDone: true });
  });

  it("excluding a channel deletes what was copied from it", async () => {
    await setSlackMirrorChannelExcluded({ docoId: "doco_slack", channelId: "C2", excluded: true });

    const status = await loadSlackMirrorStatus("doco_slack");
    expect(status?.messageCount).toBe(1);
    expect(status?.channels.find((c) => c.channelId === "C2")).toMatchObject({ excluded: true });
  });

  it("re-including a channel clears the exclusion (the next sync joins and copies it)", async () => {
    await setSlackMirrorChannelExcluded({ docoId: "doco_slack", channelId: "C2", excluded: true });
    await setSlackMirrorChannelExcluded({ docoId: "doco_slack", channelId: "C2", excluded: false });

    const status = await loadSlackMirrorStatus("doco_slack");
    expect(status?.channels.find((c) => c.channelId === "C2")).toMatchObject({ excluded: false });
  });

  it("stopping the mirror deletes the whole copy", async () => {
    await stopSlackMirror("doco_slack");

    expect(await loadSlackMirrorStatus("doco_slack")).toBeNull();
    const r = await dbm.db.query("SELECT 1 FROM group_chat_messages");
    expect(r.rows).toHaveLength(0);
  });
});
