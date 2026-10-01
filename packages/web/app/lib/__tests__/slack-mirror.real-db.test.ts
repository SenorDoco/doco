// Real-DB exercise of the Slack public-channel mirror's live path: every Slack
// event the app receives is applied to the mirror tables. PGlite runs the real
// schema; only @doco/db's withClient is pointed at it.
//
// Rules pinned here:
//   - only PUBLIC channels that the mirror tracks (and the owner didn't
//     exclude) are copied — never DMs, private channels, or Slack Connect
//     channels shared with another organization;
//   - replays (Slack retries) and out-of-order edits are harmless;
//   - a deletion in Slack is a real deletion here.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));

import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { mirrorSlackEvent } from "../slack-mirror.server";

const TEAM = "T1";

async function seed(): Promise<void> {
  const db = await freshDb();
  dbm.db = db;
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'acme', 'Acme')",
  );
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, data)
     VALUES ('doco_slack', 'acme-slack', 'workspace_1', 'workspace_1', '{}'::jsonb)`,
  );
  await db.query(
    `INSERT INTO group_chat_installations (id, provider, workspace_id, doco_workspace_id)
     VALUES ('gci_1', 'slack', $1, 'workspace_1'), ('gci_2', 'slack', 'T_UNMIRRORED', 'workspace_1')`,
    [TEAM],
  );
  await db.query(
    `INSERT INTO group_chat_mirrors (doco_id, installation_id, team_domain, history_since, consented_at)
     VALUES ('doco_slack', 'gci_1', 'acme', now() - interval '6 years', now())`,
  );
  await db.query(
    `INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at, excluded) VALUES
       ('doco_slack', 'C_GENERAL', 'general', now(), false),
       ('doco_slack', 'C_EXCLUDED', 'hr-private-ish', now(), true)`,
  );
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel: "C_GENERAL",
    channel_type: "channel",
    user: "U_ANA",
    text: "we're hitting the connection limit again",
    ts: "1700000000.000100",
    ...overrides,
  };
}

async function messages() {
  const r = await dbm.db.query<{
    channel_id: string;
    ts: string;
    thread_ts: string | null;
    author_id: string | null;
    subtype: string | null;
    text: string;
    files: unknown;
    edited_ts: string | null;
    posted_at: Date;
  }>(
    `SELECT channel_id, ts, thread_ts, author_id, subtype, text, files, edited_ts, posted_at
       FROM group_chat_messages ORDER BY ts`,
  );
  return r.rows;
}

async function channels() {
  const r = await dbm.db.query<{ channel_id: string; name: string; archived: boolean }>(
    "SELECT channel_id, name, archived FROM group_chat_channels ORDER BY channel_id",
  );
  return r.rows;
}

beforeEach(async () => {
  await seed();
});

describe("mirroring Slack messages", () => {
  it("stores a new message in a mirrored public channel", async () => {
    await mirrorSlackEvent({ teamId: TEAM, event: message() });

    const [row] = await messages();
    expect(row).toMatchObject({
      channel_id: "C_GENERAL",
      ts: "1700000000.000100",
      thread_ts: null,
      author_id: "U_ANA",
      text: "we're hitting the connection limit again",
    });
    expect(row.posted_at.toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });

  it("stores a thread reply with its thread", async () => {
    await mirrorSlackEvent({
      teamId: TEAM,
      event: message({ ts: "1700000100.000200", thread_ts: "1700000000.000100", user: "U_BEN" }),
    });

    expect(await messages()).toMatchObject([
      { ts: "1700000100.000200", thread_ts: "1700000000.000100", author_id: "U_BEN" },
    ]);
  });

  it("stores bot messages, attributed to the bot", async () => {
    await mirrorSlackEvent({
      teamId: TEAM,
      event: message({
        user: undefined,
        bot_id: "B_ALERTS",
        subtype: "bot_message",
        text: "CPU 95%",
      }),
    });

    expect(await messages()).toMatchObject([
      { author_id: "B_ALERTS", subtype: "bot_message", text: "CPU 95%" },
    ]);
  });

  it("keeps file metadata and links only, never the file itself", async () => {
    await mirrorSlackEvent({
      teamId: TEAM,
      event: message({
        subtype: "file_share",
        files: [
          {
            id: "F1",
            name: "plan.pdf",
            mimetype: "application/pdf",
            size: 1234,
            permalink: "https://acme.slack.com/files/U_ANA/F1/plan.pdf",
            url_private_download: "https://files.slack.com/files-pri/T1-F1/download/plan.pdf",
          },
        ],
      }),
    });

    const [row] = await messages();
    expect(row.files).toEqual([
      {
        id: "F1",
        name: "plan.pdf",
        mimetype: "application/pdf",
        size: 1234,
        permalink: "https://acme.slack.com/files/U_ANA/F1/plan.pdf",
      },
    ]);
  });

  it("ignores a Slack retry of the same message", async () => {
    await mirrorSlackEvent({ teamId: TEAM, event: message() });
    await mirrorSlackEvent({ teamId: TEAM, event: message() });

    expect(await messages()).toHaveLength(1);
  });

  it("skips channel join/leave notices", async () => {
    await mirrorSlackEvent({
      teamId: TEAM,
      event: message({ subtype: "channel_join", text: "<@U_ANA> has joined the channel" }),
    });

    expect(await messages()).toHaveLength(0);
  });

  it.each([
    ["a DM", { channel: "D1", channel_type: "im" }],
    ["a private channel", { channel: "G1", channel_type: "group" }],
    ["an untracked public channel", { channel: "C_OTHER" }],
    ["a channel the owner excluded", { channel: "C_EXCLUDED" }],
  ])("never copies a message from %s", async (_label, overrides) => {
    await mirrorSlackEvent({ teamId: TEAM, event: message(overrides) });

    expect(await messages()).toHaveLength(0);
  });

  it("never copies a message from a channel shared with another organization", async () => {
    await mirrorSlackEvent({ teamId: TEAM, event: message(), isExtSharedChannel: true });

    expect(await messages()).toHaveLength(0);
  });

  it("does nothing for a Slack team with no mirror", async () => {
    await mirrorSlackEvent({ teamId: "T_UNMIRRORED", event: message() });
    await mirrorSlackEvent({ teamId: "T_UNKNOWN", event: message() });

    expect(await messages()).toHaveLength(0);
  });
});

describe("mirroring edits and deletions", () => {
  function edit(text: string, editedTs: string) {
    return message({
      subtype: "message_changed",
      ts: "1700000500.000000",
      message: {
        type: "message",
        user: "U_ANA",
        text,
        ts: "1700000000.000100",
        edited: { user: "U_ANA", ts: editedTs },
      },
    });
  }

  it("applies an edit", async () => {
    await mirrorSlackEvent({ teamId: TEAM, event: message() });
    await mirrorSlackEvent({
      teamId: TEAM,
      event: edit("fixed: pooler in transaction mode", "1700000300.000000"),
    });

    expect(await messages()).toMatchObject([
      { text: "fixed: pooler in transaction mode", edited_ts: "1700000300.000000" },
    ]);
  });

  it("ignores an older edit that arrives after a newer one", async () => {
    await mirrorSlackEvent({ teamId: TEAM, event: message() });
    await mirrorSlackEvent({ teamId: TEAM, event: edit("second edit", "1700000400.000000") });
    await mirrorSlackEvent({ teamId: TEAM, event: edit("first edit", "1700000300.000000") });

    expect(await messages()).toMatchObject([{ text: "second edit" }]);
  });

  it("deletes a message deleted in Slack", async () => {
    await mirrorSlackEvent({ teamId: TEAM, event: message() });
    await mirrorSlackEvent({
      teamId: TEAM,
      event: message({
        subtype: "message_deleted",
        ts: "1700000600.000000",
        deleted_ts: "1700000000.000100",
      }),
    });

    expect(await messages()).toHaveLength(0);
  });
});

describe("mirroring channel and member changes", () => {
  it("tracks renames and archiving", async () => {
    await mirrorSlackEvent({
      teamId: TEAM,
      event: { type: "channel_rename", channel: { id: "C_GENERAL", name: "announcements" } },
    });
    await mirrorSlackEvent({
      teamId: TEAM,
      event: { type: "channel_archive", channel: "C_GENERAL" },
    });

    expect(await channels()).toContainEqual({
      channel_id: "C_GENERAL",
      name: "announcements",
      archived: true,
    });
  });

  it.each(["channel_deleted", "channel_shared"])(
    "drops a channel and its messages on %s",
    async (type) => {
      await mirrorSlackEvent({ teamId: TEAM, event: message() });
      await mirrorSlackEvent({ teamId: TEAM, event: { type, channel: "C_GENERAL" } });

      expect((await channels()).map((c) => c.channel_id)).not.toContain("C_GENERAL");
      expect(await messages()).toHaveLength(0);
    },
  );

  it("starts tracking a newly created public channel (the bot joins it later)", async () => {
    await mirrorSlackEvent({
      teamId: TEAM,
      event: { type: "channel_created", channel: { id: "C_NEW", name: "launch" } },
    });

    const r = await dbm.db.query<{ name: string; joined_at: Date | null }>(
      "SELECT name, joined_at FROM group_chat_channels WHERE channel_id = 'C_NEW'",
    );
    expect(r.rows).toEqual([{ name: "launch", joined_at: null }]);
  });

  it("keeps member names current", async () => {
    await mirrorSlackEvent({
      teamId: TEAM,
      event: {
        type: "user_change",
        user: {
          id: "U_ANA",
          name: "ana",
          real_name: "Ana Ruiz",
          is_bot: false,
          deleted: false,
          profile: { display_name: "Ana", real_name: "Ana Ruiz", image_72: "https://a/72.png" },
        },
      },
    });

    const r = await dbm.db.query(
      "SELECT chat_user_id, display_name, real_name, avatar_url, is_bot, deactivated FROM group_chat_members",
    );
    expect(r.rows).toEqual([
      {
        chat_user_id: "U_ANA",
        display_name: "Ana",
        real_name: "Ana Ruiz",
        avatar_url: "https://a/72.png",
        is_bot: false,
        deactivated: false,
      },
    ]);
  });
});

describe("the copy goes away with its Doco or its Slack install", () => {
  async function copiedRows(): Promise<number> {
    const r = await dbm.db.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM group_chat_mirrors)
            + (SELECT count(*) FROM group_chat_channels)
            + (SELECT count(*) FROM group_chat_messages)
            + (SELECT count(*) FROM group_chat_members) AS n`,
    );
    return Number(r.rows[0].n);
  }

  beforeEach(async () => {
    await mirrorSlackEvent({ teamId: TEAM, event: message() });
    await mirrorSlackEvent({
      teamId: TEAM,
      event: { type: "team_join", user: { id: "U_ANA", name: "ana" } },
    });
    expect(await copiedRows()).toBeGreaterThan(0);
  });

  it("uninstalling Slack deletes the whole copy", async () => {
    await dbm.db.query("DELETE FROM group_chat_installations WHERE id = 'gci_1'");
    expect(await copiedRows()).toBe(0);
  });

  it("purging the Doco deletes the whole copy", async () => {
    await dbm.db.query("DELETE FROM docos WHERE id = 'doco_slack'");
    expect(await copiedRows()).toBe(0);
  });

  it("stops copying once the Doco is deleted (tombstoned)", async () => {
    await dbm.db.query("UPDATE docos SET deleted_at = now() WHERE id = 'doco_slack'");
    await mirrorSlackEvent({ teamId: TEAM, event: message({ ts: "1700000999.000100" }) });
    const r = await dbm.db.query(
      "SELECT 1 FROM group_chat_messages WHERE ts = '1700000999.000100'",
    );
    expect(r.rows).toHaveLength(0);
  });
});
