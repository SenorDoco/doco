// Real-DB exercise of the Notion mirror's paced sync: one tick runs every
// minute per mirror and, within its request budget, walks Notion search from
// its cursor, drains the pages flagged for a fetch, and keeps members current.
// PGlite runs the real schema; Notion is a fake routed by method and path.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));

import { getNotionTokens } from "../notion-mirror-setup.server";
import {
  CONTENT_SCAN,
  listActiveNotionMirrors,
  runNotionMirrorTick,
} from "../notion-mirror-sync.server";
import { encryptSecret } from "../secret-box.server";

type Json = Record<string, unknown>;
type Call = { method: string; path: string; body: Json | null };
type Handler = (call: Call, params: Record<string, string>) => Response | Json;

const T0 = new Date("2026-09-28T12:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const iso = (seconds: number) => at(seconds).toISOString();

const P1 = "aaaaaaaa-0000-0000-0000-000000000001";
const P2 = "aaaaaaaa-0000-0000-0000-000000000002";
const OLD = "aaaaaaaa-0000-0000-0000-00000000000f";
const DS = "bbbbbbbb-0000-0000-0000-000000000001";
const ROW = "bbbbbbbb-0000-0000-0000-000000000002";

/** A fake Notion API: routes keyed "METHOD /path/with/:params". */
function fakeNotion(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
    const call = { method, path, body };
    calls.push(call);
    for (const [key, handler] of Object.entries(routes)) {
      const [routeMethod, routePath] = key.split(" ");
      if (routeMethod !== method) continue;
      const params = matchPath(routePath, path);
      if (!params) continue;
      const answer = handler(call, params);
      return answer instanceof Response
        ? answer
        : new Response(JSON.stringify(answer), {
            headers: { "content-type": "application/json" },
          });
    }
    return new Response(
      JSON.stringify({ object: "error", code: "object_not_found", message: "no route" }),
      { status: 404 },
    );
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = b[i];
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

const notFound = () =>
  new Response(JSON.stringify({ object: "error", code: "object_not_found", message: "gone" }), {
    status: 404,
  });
const rateLimited = (seconds: number) =>
  new Response("", { status: 429, headers: { "Retry-After": String(seconds) } });

function page(id: string, extra: Json = {}): Json {
  return {
    object: "page",
    id,
    created_time: iso(-3600),
    last_edited_time: iso(-60),
    last_edited_by: { object: "user", id: "u1" },
    parent: { type: "workspace", workspace: true },
    icon: { type: "emoji", emoji: "📘" },
    in_trash: false,
    properties: { title: { type: "title", title: [{ plain_text: `Page ${id.slice(-1)}` }] } },
    url: `https://www.notion.so/Page-${id.replace(/-/g, "")}`,
    ...extra,
  };
}

function list(results: Json[], nextCursor: string | null = null): Json {
  return { object: "list", results, next_cursor: nextCursor, has_more: nextCursor !== null };
}

const markdownFor =
  (texts: Record<string, string>): Handler =>
  (_call, params) => ({
    object: "page_markdown",
    id: params.id,
    markdown: texts[params.id] ?? `# Page\n\nBody of ${params.id}`,
    truncated: false,
    unknown_block_ids: [],
  });

const noUsers: Handler = () => list([]);

async function rows() {
  const r = await dbm.db.query<{
    page_id: string;
    object: string;
    title: string;
    parent_id: string | null;
    markdown: string;
    plain_text: string;
    fetch_pending: boolean;
    fetch_reason: string | null;
    fetch_attempts: number;
    fetch_error: string | null;
    synced_at: Date | null;
    truncated: boolean;
  }>(
    `SELECT page_id, object, title, parent_id, markdown, plain_text, fetch_pending, fetch_reason,
            fetch_attempts, fetch_error, synced_at, truncated
       FROM notion_pages ORDER BY page_id`,
  );
  return r.rows;
}

async function mirror() {
  const r = await dbm.db.query<{
    discovery_cursor: string | null;
    discovered_at: Date | null;
    reconciled_at: Date | null;
    next_at: Date | null;
    ticked_at: Date | null;
    ticking_until: Date | null;
    needs_reauth_at: Date | null;
    users_synced_at: Date | null;
  }>(
    `SELECT discovery_cursor, discovered_at, reconciled_at, next_at, ticked_at, ticking_until,
            needs_reauth_at, users_synced_at
       FROM notion_mirrors WHERE doco_id = 'doco_notion'`,
  );
  return r.rows[0];
}

const tick = (seconds: number, fetchImpl: typeof fetch, requestsPerMinute?: number) =>
  runNotionMirrorTick({
    docoId: "doco_notion",
    now: at(seconds),
    fetchImpl,
    ...(requestsPerMinute ? { requestsPerMinute } : {}),
  });

beforeEach(async () => {
  vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("DOCO_NOTION_CLIENT_ID", "client");
  vi.stubEnv("DOCO_NOTION_CLIENT_SECRET", "secret");
  const db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  dbm.db = db;
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'acme', 'Acme');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_notion', 'acme-notion', 'workspace_1', 'workspace_1', '{}'::jsonb);
  `);
  await db.query(
    `INSERT INTO notion_mirrors (doco_id, workspace_id, workspace_name, bot_id, access_token,
                                 refresh_token, consented_at)
     VALUES ('doco_notion', 'ws-1', 'Acme', 'bot-1', $1, $2, $3)`,
    [encryptSecret("ntn_access"), encryptSecret("ntn_refresh"), T0],
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("discovery", () => {
  it("walks the shared pages, stubs them from the listing, and copies their content", async () => {
    const notion = fakeNotion({
      "POST /search": () =>
        list([page(P1), page(P2, { parent: { type: "page_id", page_id: P1 } })]),
      "GET /pages/:id/markdown": markdownFor({ [P1]: "# One\n\nHello **world**." }),
      "GET /users": noUsers,
    });

    const result = await tick(0, notion.fetchImpl);

    expect(result).toMatchObject({
      discovery: "finished",
      listed: 2,
      fetched: 2,
      failed: 0,
      rateLimited: false,
    });
    expect(notion.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /search",
      `GET /pages/${P1}/markdown`,
      `GET /pages/${P2}/markdown`,
      "GET /users",
    ]);
    const [one, two] = await rows();
    expect(one).toMatchObject({
      title: "Page 1",
      parent_id: null,
      markdown: "# One\n\nHello **world**.",
      plain_text: "One\n\nHello world.",
      fetch_pending: false,
      fetch_reason: null,
    });
    expect(one.synced_at).not.toBeNull();
    expect(two).toMatchObject({ title: "Page 2", parent_id: P1, fetch_pending: false });
    expect(await mirror()).toMatchObject({
      discovery_cursor: null,
      discovered_at: T0,
      reconciled_at: T0,
      ticked_at: T0,
      ticking_until: null,
      users_synced_at: T0,
    });
  });

  it("continues a walk from its cursor on the next tick, then finishes it", async () => {
    const notion = fakeNotion({
      "POST /search": (call) =>
        call.body?.start_cursor === "c2" ? list([page(P2)]) : list([page(P1)], "c2"),
      "GET /pages/:id/markdown": markdownFor({}),
      "GET /users": noUsers,
    });

    const first = await tick(0, notion.fetchImpl, 1);
    expect(first).toMatchObject({ discovery: "walking", listed: 1, fetched: 0 });
    expect(await mirror()).toMatchObject({ discovery_cursor: "c2", discovered_at: null });

    const second = await tick(61, notion.fetchImpl);
    expect(second).toMatchObject({ discovery: "finished", listed: 1, fetched: 2 });
    const searches = notion.calls.filter((c) => c.path === "/search");
    expect(searches.map((c) => c.body?.start_cursor)).toEqual([undefined, "c2"]);
    expect((await rows()).map((r) => r.fetch_pending)).toEqual([false, false]);
  });

  it("re-verifies rows a finished walk never saw, deleting the ones Notion no longer serves", async () => {
    await dbm.db.query(
      `INSERT INTO notion_pages (doco_id, page_id, object, url, title, fetch_pending, seen_at, synced_at)
       VALUES ('doco_notion', $1, 'page', 'https://www.notion.so/old', 'Unshared', false, $3, $3),
              ('doco_notion', $2, 'page', 'https://www.notion.so/keep', 'Kept', false, $3, $3)`,
      [OLD, P2, at(-86_400)],
    );
    const notion = fakeNotion({
      "POST /search": () => list([page(P1)]),
      "GET /pages/:id": (_call, params) => (params.id === OLD ? notFound() : page(params.id)),
      "GET /pages/:id/markdown": markdownFor({}),
      "GET /users": noUsers,
    });

    await tick(0, notion.fetchImpl);

    const all = await rows();
    expect(all.map((r) => r.page_id)).toEqual([P1, P2]);
    expect(all[1]).toMatchObject({ title: "Page 2", fetch_pending: false });
    expect(notion.calls.map((c) => c.path)).toContain(`/pages/${OLD}`);
  });

  it("drops a page the listing shows in the trash", async () => {
    await dbm.db.query(
      `INSERT INTO notion_pages (doco_id, page_id, object, url, fetch_pending, synced_at)
       VALUES ('doco_notion', $1, 'page', 'https://www.notion.so/p1', false, now())`,
      [P1],
    );
    const notion = fakeNotion({
      "POST /search": () => list([page(P1, { in_trash: true })]),
      "GET /users": noUsers,
    });

    await tick(0, notion.fetchImpl);

    expect(await rows()).toEqual([]);
  });
});

describe("pacing", () => {
  it("a rate limit ends the tick and pauses the mirror for Notion's Retry-After", async () => {
    let searches = 0;
    const notion = fakeNotion({
      "POST /search": () => (++searches === 1 ? rateLimited(30) : list([page(P1)])),
      "GET /pages/:id/markdown": markdownFor({}),
      "GET /users": noUsers,
    });

    const first = await tick(0, notion.fetchImpl);
    expect(first).toMatchObject({ rateLimited: true, discovery: "walking", fetched: 0 });
    expect((await mirror()).next_at).toEqual(at(30));

    expect(await tick(10, notion.fetchImpl)).toMatchObject({ skipped: "paused" });
    expect(await tick(40, notion.fetchImpl)).toMatchObject({ discovery: "finished", fetched: 1 });
  });

  it("a lease keeps the next tick off a mirror whose tick is still running", async () => {
    await dbm.db.query("UPDATE notion_mirrors SET ticking_until = $1", [at(30)]);
    const notion = fakeNotion({ "POST /search": () => list([]), "GET /users": noUsers });

    expect(await tick(0, notion.fetchImpl)).toMatchObject({ skipped: "lease" });
    expect(await tick(31, notion.fetchImpl)).toMatchObject({ discovery: "finished" });
    expect(notion.calls).toHaveLength(2);
  });

  it("parks a page Notion keeps refusing, and copies the rest", async () => {
    const notion = fakeNotion({
      "POST /search": () => list([page(P1), page(P2)]),
      // A retry re-reads the page object first (Notion may have unshared it).
      "GET /pages/:id": (_call, params) => page(params.id),
      "GET /pages/:id/markdown": (_call, params) =>
        params.id === P1
          ? new Response(
              JSON.stringify({ object: "error", code: "restricted_resource", message: "no" }),
              { status: 403 },
            )
          : markdownFor({})(_call, params),
      "GET /users": noUsers,
    });

    for (let minute = 0; minute < 6; minute++) await tick(minute * 61, notion.fetchImpl);

    const [one, two] = await rows();
    expect(one).toMatchObject({ fetch_pending: false, fetch_attempts: 5 });
    expect(one.fetch_error).toContain("restricted_resource");
    expect(one.synced_at).toBeNull();
    expect(two).toMatchObject({ fetch_pending: false });
    expect(notion.calls.filter((c) => c.path === `/pages/${P1}/markdown`)).toHaveLength(5);
  });

  it("fetches webhook-flagged pages first, re-reading them from Notion", async () => {
    await dbm.db.query(
      "UPDATE notion_mirrors SET discovered_at = $1, reconciled_at = $1, users_synced_at = $1",
      [T0],
    );
    await dbm.db.query(
      `INSERT INTO notion_pages (doco_id, page_id, object, url, fetch_pending, fetch_reason) VALUES
         ('doco_notion', $1, 'page', 'https://www.notion.so/p1', true, 'discover'),
         ('doco_notion', $2, 'page', 'https://www.notion.so/p2', true, 'webhook')`,
      [P1, P2],
    );
    const notion = fakeNotion({
      "GET /pages/:id": (_call, params) =>
        page(params.id, {
          properties: { Name: { type: "title", title: [{ plain_text: "Fresh" }] } },
        }),
      "GET /pages/:id/markdown": markdownFor({}),
    });

    await tick(30, notion.fetchImpl, 2);

    expect(notion.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /pages/${P2}`,
      `GET /pages/${P2}/markdown`,
    ]);
    const [one, two] = await rows();
    expect(two).toMatchObject({ title: "Fresh", fetch_pending: false });
    expect(one).toMatchObject({ fetch_pending: true });
  });
});

describe("reconcile", () => {
  it("flags pages edited since the last reconcile every 15 minutes, and nothing else", async () => {
    const notion = fakeNotion({
      "POST /search": () =>
        list([
          page(P2, { last_edited_time: iso(15 * 60) }),
          page(P1, { last_edited_time: iso(-60) }),
        ]),
      "GET /pages/:id/markdown": markdownFor({}),
      "GET /users": noUsers,
    });
    await dbm.db.query(
      "UPDATE notion_mirrors SET discovered_at = $1, reconciled_at = $1, users_synced_at = $1",
      [T0],
    );
    await dbm.db.query(
      `INSERT INTO notion_pages (doco_id, page_id, object, url, last_edited_time, fetch_pending, synced_at) VALUES
         ('doco_notion', $1, 'page', 'https://www.notion.so/p1', $3, false, $4),
         ('doco_notion', $2, 'page', 'https://www.notion.so/p2', $3, false, $4)`,
      [P1, P2, at(-60), T0],
    );

    expect(await tick(5 * 60, notion.fetchImpl)).toMatchObject({ discovery: "none" });
    const result = await tick(16 * 60, notion.fetchImpl);

    expect(result).toMatchObject({ discovery: "reconciled", listed: 1, fetched: 1 });
    expect(notion.calls.map((c) => c.path)).toEqual(["/search", `/pages/${P2}/markdown`]);
    expect((await mirror()).reconciled_at).toEqual(at(16 * 60));
  });
});

describe("data sources", () => {
  it("copies a data source's schema as its text and its rows as pages", async () => {
    const dataSource = {
      object: "data_source",
      id: DS,
      title: [{ plain_text: "Tasks" }],
      description: [{ plain_text: "What the team is doing." }],
      parent: { type: "database_id", database_id: "cccccccc-0000-0000-0000-000000000001" },
      database_parent: { type: "page_id", page_id: P1 },
      properties: {
        Name: { type: "title", title: {} },
        Status: { type: "status", status: { options: [{ name: "Todo" }, { name: "Done" }] } },
      },
      last_edited_time: iso(-60),
      in_trash: false,
    };
    const row = page(ROW, {
      parent: { type: "data_source_id", data_source_id: DS },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Ship it" }] },
        Status: { type: "status", status: { name: "Done" } },
      },
    });
    const notion = fakeNotion({
      "POST /search": () => list([dataSource]),
      "GET /data_sources/:id": () => dataSource,
      "POST /data_sources/:id/query": () => list([row]),
      "GET /pages/:id/markdown": markdownFor({ [ROW]: "Details of the task." }),
      "GET /users": noUsers,
    });

    const result = await tick(0, notion.fetchImpl);

    expect(result).toMatchObject({ listed: 1, fetched: 2 });
    const [ds, task] = await rows();
    expect(ds).toMatchObject({
      object: "data_source",
      title: "Tasks",
      parent_id: P1,
      fetch_pending: false,
    });
    expect(ds.markdown).toBe(
      "What the team is doing.\n\nProperties:\n- **Name**: title\n- **Status**: status (Todo, Done)",
    );
    expect(task).toMatchObject({
      object: "page",
      title: "Ship it",
      parent_id: DS,
      markdown: "**Name:** Ship it · **Status:** Done\n\nDetails of the task.",
      plain_text: "Name: Ship it · Status: Done\n\nDetails of the task.",
      fetch_pending: false,
    });
  });
});

describe("content details", () => {
  it("appends the subtrees of a truncated page and records the pages it links to", async () => {
    const notion = fakeNotion({
      "POST /search": () => list([page(P1), page(P2)]),
      "GET /pages/:id/markdown": (_call, params) =>
        params.id === P1
          ? {
              markdown: `Start. <page url="https://www.notion.so/Two-${P2.replace(/-/g, "")}">Two</page>`,
              truncated: true,
              unknown_block_ids: ["block-1"],
            }
          : params.id === "block-1"
            ? { markdown: "The rest.", truncated: false, unknown_block_ids: [] }
            : { markdown: "Two.", truncated: false, unknown_block_ids: [] },
      "GET /users": noUsers,
    });

    await tick(0, notion.fetchImpl);

    const [one] = await rows();
    expect(one.markdown).toBe(
      `Start. <page url="https://www.notion.so/Two-${P2.replace(/-/g, "")}">Two</page>\n\nThe rest.`,
    );
    expect(one.truncated).toBe(false);
    const links = await dbm.db.query<{ from_page_id: string; to_page_id: string }>(
      "SELECT from_page_id, to_page_id FROM notion_links",
    );
    expect(links.rows).toEqual([{ from_page_id: P1, to_page_id: P2 }]);
  });
});

describe("tokens", () => {
  it("refreshes the token once on 401 and keeps the new pair", async () => {
    let searches = 0;
    const notion = fakeNotion({
      "POST /search": () =>
        ++searches === 1
          ? new Response(JSON.stringify({ code: "unauthorized", message: "expired" }), {
              status: 401,
            })
          : list([page(P1)]),
      "POST /oauth/token": () => ({
        access_token: "ntn_access2",
        refresh_token: "ntn_refresh2",
        bot_id: "bot-1",
        workspace_id: "ws-1",
      }),
      "GET /pages/:id/markdown": markdownFor({}),
      "GET /users": noUsers,
    });

    expect(await tick(0, notion.fetchImpl)).toMatchObject({ discovery: "finished", fetched: 1 });
    expect(await getNotionTokens("doco_notion")).toEqual({
      accessToken: "ntn_access2",
      refreshToken: "ntn_refresh2",
    });
    expect((await mirror()).needs_reauth_at).toBeNull();
  });

  it("asks for a reconnect when the refresh is refused, and stays quiet until then", async () => {
    const notion = fakeNotion({
      "POST /search": () =>
        new Response(JSON.stringify({ code: "unauthorized", message: "revoked" }), {
          status: 401,
        }),
      "POST /oauth/token": () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    });

    expect(await tick(0, notion.fetchImpl)).toMatchObject({ discovery: "walking", fetched: 0 });
    expect((await mirror()).needs_reauth_at).not.toBeNull();
    expect(await tick(61, notion.fetchImpl)).toMatchObject({ skipped: "reauth" });
  });
});

describe("members", () => {
  it("loads members hourly, tolerating a workspace that grants no user information", async () => {
    const forbidden = fakeNotion({
      "POST /search": () => list([]),
      "GET /users": () =>
        new Response(JSON.stringify({ code: "restricted_resource", message: "no" }), {
          status: 403,
        }),
    });
    await tick(0, forbidden.fetchImpl);
    expect((await mirror()).users_synced_at).toEqual(T0);

    const granted = fakeNotion({
      "POST /search": () => list([]),
      "GET /users": () =>
        list([
          { object: "user", id: "u1", type: "person", name: "Tania" },
          { object: "user", id: "b1", type: "bot", name: "Doco" },
        ]),
    });
    await tick(30, granted.fetchImpl);
    expect(granted.calls.map((c) => c.path)).not.toContain("/users");
    await tick(3601, granted.fetchImpl);
    const users = await dbm.db.query<{ user_id: string; name: string }>(
      "SELECT user_id, name FROM notion_users ORDER BY user_id",
    );
    expect(users.rows).toEqual([
      { user_id: "b1", name: "Doco" },
      { user_id: "u1", name: "Tania" },
    ]);
  });
});

describe("listActiveNotionMirrors", () => {
  it("lists live mirrors, skipping deleted Docos", async () => {
    expect(await listActiveNotionMirrors()).toEqual([{ docoId: "doco_notion" }]);
    await dbm.db.query("UPDATE docos SET deleted_at = now() WHERE id = 'doco_notion'");
    expect(await listActiveNotionMirrors()).toEqual([]);
  });
});

describe("children", () => {
  const DB = "cccccccc-0000-0000-0000-000000000001";
  const bare = (id: string) => id.replace(/-/g, "");

  it("queues the child pages a copied page names that the listing missed, and copies them", async () => {
    const notion = fakeNotion({
      "POST /search": () => list([page(P1)]),
      "GET /pages/:id": (_call, params) =>
        page(params.id, { parent: { type: "page_id", page_id: P1 } }),
      "GET /pages/:id/markdown": markdownFor({
        [P1]: `Start.\n<page url="https://www.notion.so/Two-${bare(P2)}">Two</page>`,
        [P2]: "Two's body.",
      }),
      "GET /users": noUsers,
    });

    const result = await tick(0, notion.fetchImpl);

    expect(result).toMatchObject({ listed: 1, fetched: 2 });
    const [one, two] = await rows();
    expect(one).toMatchObject({ page_id: P1, fetch_pending: false });
    expect(two).toMatchObject({
      page_id: P2,
      parent_id: P1,
      title: "Page 2",
      markdown: "Two's body.",
      fetch_pending: false,
      fetch_reason: null,
    });
    expect(notion.calls.map((c) => c.path)).toContain(`/pages/${P2}`);
  });

  it("resolves a child database into its data sources under the page, and copies their rows", async () => {
    const dataSource = {
      object: "data_source",
      id: DS,
      title: [{ plain_text: "Tasks" }],
      description: [],
      parent: { type: "database_id", database_id: DB },
      database_parent: { type: "page_id", page_id: P1 },
      properties: { Name: { type: "title", title: {} } },
      last_edited_time: iso(-60),
      in_trash: false,
    };
    const taskRow = page(ROW, {
      parent: { type: "data_source_id", data_source_id: DS },
      properties: { Name: { type: "title", title: [{ plain_text: "Ship it" }] } },
    });
    let databaseCalls = 0;
    const notion = fakeNotion({
      "POST /search": () => list([page(P1)]),
      "GET /pages/:id/markdown": markdownFor({
        [P1]: `<database url="https://www.notion.so/${bare(DB)}" inline="true">Tasks</database>`,
        [ROW]: "Details of the task.",
      }),
      // The first lookup fails: the retry is a database lookup again, not a
      // data-source fetch of the database's id.
      "GET /databases/:id": () =>
        ++databaseCalls === 1
          ? new Response("", { status: 500 })
          : {
              object: "database",
              id: DB,
              icon: { type: "emoji", emoji: "📋" },
              in_trash: false,
              data_sources: [{ id: DS, name: "Tasks" }],
            },
      "GET /data_sources/:id": () => dataSource,
      "POST /data_sources/:id/query": () => list([taskRow]),
      "GET /users": noUsers,
    });

    await tick(0, notion.fetchImpl);

    const all = await rows();
    expect(all.map((r) => [r.page_id, r.object, r.parent_id, r.title, r.fetch_pending])).toEqual([
      [P1, "page", null, "Page 1", false],
      [DS, "data_source", P1, "Tasks", false],
      [ROW, "page", DS, "Ship it", false],
    ]);
    expect(notion.calls.filter((c) => c.path === `/databases/${DB}`)).toHaveLength(2);
    expect(notion.calls.map((c) => c.path)).not.toContain(`/data_sources/${DB}`);
  });

  it("takes a capped listing for what it is: pages it left out are kept, not re-verified", async () => {
    await dbm.db.query(
      `INSERT INTO notion_pages (doco_id, page_id, object, url, title, fetch_pending, seen_at, synced_at)
       VALUES ('doco_notion', $1, 'page', 'https://www.notion.so/old', 'Unlisted', false, $2, $2)`,
      [OLD, at(-86_400)],
    );
    const notion = fakeNotion({
      "POST /search": () => ({
        ...list([page(P1)]),
        request_status: { type: "incomplete", reason: "query_result_limit_reached" },
      }),
      "GET /pages/:id/markdown": markdownFor({}),
      "GET /users": noUsers,
    });

    await tick(0, notion.fetchImpl);

    const unlisted = (await rows()).find((r) => r.page_id === OLD);
    expect(unlisted).toMatchObject({ title: "Unlisted", fetch_pending: false });
    expect(notion.calls.map((c) => c.path)).not.toContain(`/pages/${OLD}`);
    const m = await dbm.db.query<{ listing_capped_at: Date | null; discovered_at: Date | null }>(
      "SELECT listing_capped_at, discovered_at FROM notion_mirrors",
    );
    expect(m.rows[0]).toEqual({ listing_capped_at: at(0), discovered_at: at(0) });
  });

  it("reads the copied pages again once per scan version: links recorded, children queued", async () => {
    // Copied before the sync read links and children this way: Notion's own
    // app.notion.com URL, no recorded link, no queued child.
    await dbm.db.query(
      `INSERT INTO notion_pages
         (doco_id, page_id, object, url, title, markdown, fetch_pending, seen_at, synced_at)
       VALUES ('doco_notion', $1, 'page', 'https://www.notion.so/one', 'One', $3, false, $2, $2)`,
      [P1, at(-86_400), `<page url="https://app.notion.com/p/Two-${bare(P2)}">Two</page>`],
    );
    await dbm.db.query(
      `UPDATE notion_mirrors SET discovered_at = $1, reconciled_at = $1, content_scan = 'older'
        WHERE doco_id = 'doco_notion'`,
      [at(-60)],
    );
    const notion = fakeNotion({
      "GET /pages/:id": (_call, params) =>
        page(params.id, { parent: { type: "page_id", page_id: P1 } }),
      "GET /pages/:id/markdown": markdownFor({ [P2]: "Two." }),
      "GET /users": noUsers,
    });

    await tick(0, notion.fetchImpl);

    expect((await rows()).find((r) => r.page_id === P2)).toMatchObject({
      parent_id: P1,
      title: "Page 2",
      markdown: "Two.",
      fetch_pending: false,
    });
    const links = await dbm.db.query<{ from_page_id: string; to_page_id: string }>(
      "SELECT from_page_id, to_page_id FROM notion_links",
    );
    expect(links.rows).toEqual([{ from_page_id: P1, to_page_id: P2 }]);
    const scanned = await dbm.db.query<{ content_scan: string | null }>(
      "SELECT content_scan FROM notion_mirrors",
    );
    expect(scanned.rows[0].content_scan).toBe(CONTENT_SCAN);

    // Read once per version: a child dropped later is not queued again by the scan.
    await dbm.db.query("DELETE FROM notion_pages WHERE page_id = $1", [P2]);
    await tick(60, notion.fetchImpl);
    expect((await rows()).map((r) => r.page_id)).toEqual([P1]);
  });
});
