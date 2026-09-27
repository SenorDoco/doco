// Real-DB exercise of the Slack mirror's paced history backfill: one sync tick
// runs every minute and, per Slack team, makes at most one conversations.history
// call and one conversations.replies call (Slack's limit for apps not listed on
// its Marketplace), filling every channel newest-first. PGlite runs the real
// schema; Slack is a fake routed by method name.
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

import { listActiveSlackMirrors, runSlackMirrorTick } from "../slack-mirror-sync.server";

const T0 = new Date("2026-09-26T12:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const HISTORY_SINCE = new Date("2020-09-26T12:00:00Z");

type Call = { method: string; params: URLSearchParams };

function fakeSlack(routes: Record<string, (params: URLSearchParams) => Response | unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = url.replace("https://slack.com/api/", "");
    const params = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ method, params });
    const answer = routes[method]?.(params) ?? { ok: false, error: "unknown_method" };
    return answer instanceof Response ? answer : new Response(JSON.stringify(answer));
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const msg = (ts: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  user: "U1",
  text: `message ${ts}`,
  ts,
  ...extra,
});

beforeEach(async () => {
  const db = new PGlite();
  await db.exec(schemaSql);
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
     VALUES ('gci_1', 'slack', 'T1', 'workspace_1')`,
  );
  await db.query(
    `INSERT INTO group_chat_mirrors
       (doco_id, installation_id, team_domain, history_since, consented_at, channels_synced_at)
     VALUES ('doco_slack', 'gci_1', 'acme', $1, $2, $2)`,
    [HISTORY_SINCE, T0],
  );
  await db.query(
    `INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at, excluded) VALUES
       ('doco_slack', 'C1', 'general', now(), false),
       ('doco_slack', 'C2', 'eng', now(), false),
       ('doco_slack', 'C3', 'excluded', now(), true),
       ('doco_slack', 'C4', 'not-joined-yet', NULL, false)`,
  );
});

async function stored(channelId: string): Promise<string[]> {
  const r = await dbm.db.query<{ ts: string }>(
    "SELECT ts FROM group_chat_messages WHERE channel_id = $1 ORDER BY ts::numeric DESC",
    [channelId],
  );
  return r.rows.map((row) => row.ts);
}

/** Two pages per channel: newer page first (Slack's order), then older. */
function historyPages(pages: Record<string, unknown[][]>) {
  return (params: URLSearchParams) => {
    const channel = params.get("channel") ?? "";
    const page = Number(params.get("cursor") || "0");
    const channelPages = pages[channel] ?? [[]];
    const hasMore = page + 1 < channelPages.length;
    return {
      ok: true,
      messages: channelPages[page] ?? [],
      has_more: hasMore,
      response_metadata: { next_cursor: hasMore ? String(page + 1) : "" },
    };
  };
}

const tick = (seconds: number, fetchImpl: typeof fetch, callsPerMinute?: number) =>
  runSlackMirrorTick({
    docoId: "doco_slack",
    token: "xoxb",
    now: at(seconds),
    fetchImpl,
    ...(callsPerMinute ? { callsPerMinute } : {}),
  });

describe("history backfill", () => {
  const pages = {
    C1: [[msg("1700000400.0"), msg("1700000300.0")], [msg("1600000000.0")]],
    C2: [[msg("1700000350.0")], [msg("1650000000.0")]],
  };

  it("makes at most one history call a minute", async () => {
    const slack = fakeSlack({ "conversations.history": historyPages(pages) });

    await tick(0, slack.fetchImpl);
    await tick(30, slack.fetchImpl);

    expect(slack.calls.filter((c) => c.method === "conversations.history")).toHaveLength(1);
  });

  it("fills every channel newest-first together, not one channel at a time", async () => {
    const slack = fakeSlack({ "conversations.history": historyPages(pages) });

    await tick(0, slack.fetchImpl); // C1 page 1 (reaches 1700000300)
    await tick(61, slack.fetchImpl); // C2 page 1 (not started yet)
    await tick(122, slack.fetchImpl); // C2 is least far back (1700000350) → C2 page 2
    await tick(183, slack.fetchImpl); // then C1 page 2

    const channels = slack.calls
      .filter((c) => c.method === "conversations.history")
      .map((c) => `${c.params.get("channel")}:${c.params.get("cursor") ?? ""}`);
    expect(channels).toEqual(["C1:", "C2:", "C2:1", "C1:1"]);
    expect(await stored("C1")).toEqual(["1700000400.0", "1700000300.0", "1600000000.0"]);
    expect(await stored("C2")).toEqual(["1700000350.0", "1650000000.0"]);
  });

  it("asks Slack for pages no older than the history floor", async () => {
    const slack = fakeSlack({ "conversations.history": historyPages(pages) });

    await tick(0, slack.fetchImpl);

    const [call] = slack.calls;
    expect(call.params.get("oldest")).toBe(String(HISTORY_SINCE.getTime() / 1000));
    expect(call.params.get("limit")).toBe("200");
  });

  it("marks a channel done when Slack has no more pages, and stops reading it", async () => {
    const slack = fakeSlack({
      "conversations.history": historyPages({ C1: [[msg("1.0")]], C2: [[msg("2.0")]] }),
    });

    for (let minute = 0; minute < 4; minute++) await tick(minute * 61, slack.fetchImpl);

    const r = await dbm.db.query<{ channel_id: string; done: boolean }>(
      "SELECT channel_id, history_done_at IS NOT NULL AS done FROM group_chat_channels WHERE channel_id IN ('C1','C2') ORDER BY channel_id",
    );
    expect(r.rows).toEqual([
      { channel_id: "C1", done: true },
      { channel_id: "C2", done: true },
    ]);
    expect(slack.calls.filter((c) => c.method === "conversations.history")).toHaveLength(2);
  });

  it("never reads an excluded channel or one the bot hasn't joined", async () => {
    const slack = fakeSlack({ "conversations.history": historyPages({}) });

    for (let minute = 0; minute < 5; minute++) await tick(minute * 61, slack.fetchImpl);

    const read = new Set(slack.calls.map((c) => c.params.get("channel")));
    expect(read.has("C3")).toBe(false);
    expect(read.has("C4")).toBe(false);
  });

  it("goes faster when the app's Slack limits allow more calls a minute", async () => {
    const slack = fakeSlack({ "conversations.history": historyPages(pages) });

    await tick(0, slack.fetchImpl, 3);

    expect(slack.calls.filter((c) => c.method === "conversations.history")).toHaveLength(3);
  });

  it("waits out Slack's Retry-After on a rate limit", async () => {
    const slack = fakeSlack({
      "conversations.history": () =>
        new Response("", { status: 429, headers: { "Retry-After": "120" } }),
    });

    const result = await tick(0, slack.fetchImpl);
    await tick(61, slack.fetchImpl);
    await tick(125, slack.fetchImpl);

    expect(result.rateLimited).toBe(true);
    expect(slack.calls.filter((c) => c.method === "conversations.history")).toHaveLength(2);
  });
});

describe("thread replies backfill", () => {
  beforeEach(async () => {
    await dbm.db.query(
      `INSERT INTO group_chat_messages (doco_id, channel_id, ts, thread_ts, reply_count, text, posted_at) VALUES
         ('doco_slack', 'C1', '1700000100.0', '1700000100.0', 3, 'older thread', now()),
         ('doco_slack', 'C1', '1700000200.0', '1700000200.0', 2, 'newer thread', now()),
         ('doco_slack', 'C3', '1700000300.0', '1700000300.0', 2, 'excluded channel thread', now())`,
    );
  });

  function replies(threads: Record<string, unknown[][]>) {
    return (params: URLSearchParams) => {
      const ts = params.get("ts") ?? "";
      const page = Number(params.get("cursor") || "0");
      const threadPages = threads[ts] ?? [[]];
      const hasMore = page + 1 < threadPages.length;
      return {
        ok: true,
        messages: threadPages[page],
        has_more: hasMore,
        response_metadata: { next_cursor: hasMore ? String(page + 1) : "" },
      };
    };
  }

  it("fetches earlier replies newest thread first, one call a minute, paging long threads", async () => {
    const slack = fakeSlack({
      "conversations.history": historyPages({}),
      "conversations.replies": replies({
        "1700000200.0": [
          [
            msg("1700000200.0", { thread_ts: "1700000200.0", reply_count: 2 }),
            msg("1700000201.0", { thread_ts: "1700000200.0" }),
          ],
          [msg("1700000202.0", { thread_ts: "1700000200.0" })],
        ],
        "1700000100.0": [[msg("1700000101.0", { thread_ts: "1700000100.0" })]],
      }),
    });

    await tick(0, slack.fetchImpl);
    await tick(30, slack.fetchImpl);
    await tick(61, slack.fetchImpl);
    await tick(122, slack.fetchImpl);

    const calls = slack.calls
      .filter((c) => c.method === "conversations.replies")
      .map((c) => `${c.params.get("ts")}:${c.params.get("cursor") ?? ""}`);
    expect(calls).toEqual(["1700000200.0:", "1700000200.0:1", "1700000100.0:"]);
    expect(await stored("C1")).toEqual([
      "1700000202.0",
      "1700000201.0",
      "1700000200.0",
      "1700000101.0",
      "1700000100.0",
    ]);
    const done = await dbm.db.query<{ ts: string }>(
      "SELECT ts FROM group_chat_messages WHERE replies_synced_at IS NOT NULL ORDER BY ts",
    );
    expect(done.rows.map((r) => r.ts)).toEqual(["1700000100.0", "1700000200.0"]);
  });
});

describe("hourly channel and member refresh", () => {
  it("re-syncs the channel list and members once the last sync is an hour old", async () => {
    await dbm.db.query("UPDATE group_chat_mirrors SET channels_synced_at = $1", [
      new Date(T0.getTime() - 61 * 60_000),
    ]);
    const slack = fakeSlack({
      "conversations.list": () => ({
        ok: true,
        channels: [
          { id: "C1", name: "general", is_member: true },
          { id: "C2", name: "eng", is_member: true },
          { id: "C3", name: "excluded", is_member: true },
          { id: "C4", name: "not-joined-yet", is_member: false },
        ],
      }),
      "conversations.join": () => ({ ok: true }),
      "users.list": () => ({ ok: true, members: [{ id: "U1", name: "ana" }] }),
      "conversations.history": historyPages({}),
    });

    const result = await tick(0, slack.fetchImpl);
    await tick(61, slack.fetchImpl);

    expect(result.channelsSynced).toBe(true);
    expect(slack.calls.filter((c) => c.method === "conversations.list")).toHaveLength(1);
    expect(slack.calls.filter((c) => c.method === "users.list")).toHaveLength(1);
    const joined = await dbm.db.query(
      "SELECT 1 FROM group_chat_channels WHERE channel_id = 'C4' AND joined_at IS NOT NULL",
    );
    expect(joined.rows).toHaveLength(1);
  });
});

describe("joining channels", () => {
  it("keeps joining every run while Slack rate-limits joins, without holding up history", async () => {
    await dbm.db.query("UPDATE group_chat_mirrors SET channels_synced_at = NULL");
    let joins = 0;
    const slack = fakeSlack({
      "conversations.list": () => ({
        ok: true,
        channels: [
          { id: "C1", name: "general", is_member: true },
          { id: "C2", name: "eng", is_member: true },
          { id: "C4", name: "not-joined-yet", is_member: false },
        ],
      }),
      "conversations.join": () =>
        ++joins === 1
          ? new Response("", { status: 429, headers: { "Retry-After": "30" } })
          : { ok: true },
      "users.list": () => ({ ok: true, members: [] }),
      "conversations.history": historyPages({}),
    });

    const first = await tick(0, slack.fetchImpl);
    const second = await tick(61, slack.fetchImpl);
    await tick(122, slack.fetchImpl);

    expect(first).toMatchObject({ channelsSynced: false, historyCalls: 1 });
    expect(second.channelsSynced).toBe(true);
    expect(slack.calls.filter((c) => c.method === "conversations.list")).toHaveLength(2);
    const joined = await dbm.db.query(
      "SELECT 1 FROM group_chat_channels WHERE channel_id = 'C4' AND joined_at IS NOT NULL",
    );
    expect(joined.rows).toHaveLength(1);
  });
});

describe("listActiveSlackMirrors", () => {
  it("lists live mirrors with their Slack team, skipping deleted Docos", async () => {
    expect(await listActiveSlackMirrors()).toEqual([{ docoId: "doco_slack", teamId: "T1" }]);
    await dbm.db.query("UPDATE docos SET deleted_at = now()");
    expect(await listActiveSlackMirrors()).toEqual([]);
  });
});
