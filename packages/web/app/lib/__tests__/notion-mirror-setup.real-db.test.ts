// Turning a Doco into a Notion mirror: the signed OAuth state, recording the
// mirror with its tokens encrypted at rest, the status the page shows, and
// stopping it. PGlite runs the real schema.
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

import type { NotionTokenResponse } from "../notion-api.server";
import {
  buildNotionAuthorizeUrl,
  enableNotionMirror,
  getNotionTokens,
  loadNotionMirrorStatus,
  markNotionMirrorNeedsReauth,
  requestNotionResync,
  signNotionState,
  stopNotionMirror,
  storeNotionTokens,
  verifyNotionState,
} from "../notion-mirror-setup.server";
import { decryptSecret, isEncryptedSecret } from "../secret-box.server";

const tokens: NotionTokenResponse = {
  access_token: "ntn_access",
  refresh_token: "ntn_refresh",
  bot_id: "bot-1",
  workspace_id: "ws-1",
  workspace_name: "Acme",
  workspace_icon: "📓",
  owner: { type: "user", user: { id: "u1", name: "Tania" } },
};

beforeEach(async () => {
  vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("DOCO_NOTION_CLIENT_ID", "client");
  vi.stubEnv("DOCO_NOTION_CLIENT_SECRET", "secret");
  const db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  dbm.db = db;
  await db.exec(`
    INSERT INTO users (id, github_login, data) VALUES ('user_owner', 'tania', '{}'::jsonb);
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'acme', 'Acme');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_notion', 'acme-notion', 'workspace_1', 'workspace_1', '{}'::jsonb),
      ('doco_other', 'acme-other', 'workspace_1', 'workspace_1', '{}'::jsonb);
  `);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function mirrorRow() {
  const r = await dbm.db.query<{
    workspace_id: string;
    workspace_name: string;
    bot_id: string;
    access_token: string;
    refresh_token: string | null;
    authorized_by: string | null;
    consented_by: string | null;
    needs_reauth_at: Date | null;
    discovered_at: Date | null;
  }>(
    `SELECT workspace_id, workspace_name, bot_id, access_token, refresh_token, authorized_by,
            consented_by, needs_reauth_at, discovered_at
       FROM notion_mirrors WHERE doco_id = 'doco_notion'`,
  );
  return r.rows[0] ?? null;
}

describe("the signed OAuth state", () => {
  const state = {
    docoId: "doco_notion",
    workspaceId: "workspace_1",
    userId: "user_owner",
    nonce: "n",
    issuedAt: 1_000_000,
  };

  it("round-trips, and rejects tampering, another key, and expiry", () => {
    const signed = signNotionState(state, "secret");
    expect(verifyNotionState(signed, "secret", 1_000_000 + 60_000)).toEqual(state);
    expect(verifyNotionState(`${signed}x`, "secret", 1_000_000)).toBeNull();
    expect(verifyNotionState(signed, "other", 1_000_000)).toBeNull();
    expect(verifyNotionState(signed, "", 1_000_000)).toBeNull();
    expect(verifyNotionState(signed, "secret", 1_000_000 + 61 * 60_000)).toBeNull();
    expect(verifyNotionState("garbage", "secret", 1_000_000)).toBeNull();
  });

  it("keeps where to return on the site, and drops one off it", () => {
    const back = { ...state, next: "/workspaces/acme" };
    expect(verifyNotionState(signNotionState(back, "secret"), "secret", 1_000_000)).toEqual(back);
    for (const next of ["//evil.test/x", "https://evil.test/x", "/\\evil.test"]) {
      const signed = signNotionState({ ...state, next }, "secret");
      expect(verifyNotionState(signed, "secret", 1_000_000)).toEqual(state);
    }
  });

  it("is carried by the authorization URL the consent form redirects to", () => {
    const url = buildNotionAuthorizeUrl(new Request("https://doco.test/acme-notion/x"), {
      docoId: "doco_notion",
      workspaceId: "workspace_1",
      userId: "user_owner",
    });
    const parsed = new URL(url ?? "");
    expect(parsed.origin + parsed.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://doco.test/integrations/notion/callback",
    );
    expect(verifyNotionState(parsed.searchParams.get("state") ?? "", "secret")).toMatchObject({
      docoId: "doco_notion",
      workspaceId: "workspace_1",
      userId: "user_owner",
    });
  });

  it("has no URL to offer when Notion isn't configured", () => {
    vi.stubEnv("DOCO_NOTION_CLIENT_SECRET", "");
    expect(
      buildNotionAuthorizeUrl(new Request("https://doco.test/x"), {
        docoId: "d",
        workspaceId: "w",
        userId: "u",
      }),
    ).toBeNull();
  });
});

describe("enableNotionMirror", () => {
  it("records the mirror with its tokens encrypted at rest", async () => {
    expect(
      await enableNotionMirror({ docoId: "doco_notion", tokens, consentedBy: "user_owner" }),
    ).toEqual({ ok: true });

    const row = await mirrorRow();
    expect(row).toMatchObject({
      workspace_id: "ws-1",
      workspace_name: "Acme",
      bot_id: "bot-1",
      authorized_by: "Tania",
      consented_by: "user_owner",
    });
    expect(isEncryptedSecret(row?.access_token ?? "")).toBe(true);
    expect(decryptSecret(row?.access_token ?? "")).toBe("ntn_access");
    expect(await getNotionTokens("doco_notion")).toEqual({
      accessToken: "ntn_access",
      refreshToken: "ntn_refresh",
    });
  });

  it("feeds one Notion workspace to one mirror", async () => {
    await enableNotionMirror({ docoId: "doco_notion", tokens, consentedBy: "user_owner" });

    expect(
      await enableNotionMirror({
        docoId: "doco_other",
        tokens: { ...tokens, bot_id: "bot-2" },
        consentedBy: "user_owner",
      }),
    ).toEqual({ ok: false, reason: "workspace_mirrored_elsewhere", handle: "acme-notion" });
  });

  it("re-authorizing replaces the tokens and clears a reauthorization flag", async () => {
    await enableNotionMirror({ docoId: "doco_notion", tokens, consentedBy: "user_owner" });
    await markNotionMirrorNeedsReauth("doco_notion");
    expect((await mirrorRow())?.needs_reauth_at).not.toBeNull();

    await enableNotionMirror({
      docoId: "doco_notion",
      tokens: { ...tokens, access_token: "ntn_access2", bot_id: "bot-2" },
      consentedBy: "user_owner",
    });

    expect(await mirrorRow()).toMatchObject({ bot_id: "bot-2", needs_reauth_at: null });
    expect((await getNotionTokens("doco_notion"))?.accessToken).toBe("ntn_access2");
  });

  it("drops the copy when a mirror is pointed at another workspace", async () => {
    await enableNotionMirror({ docoId: "doco_notion", tokens, consentedBy: "user_owner" });
    await dbm.db.query(
      `INSERT INTO notion_pages (doco_id, page_id, object, url)
       VALUES ('doco_notion', 'p1', 'page', 'https://www.notion.so/p1')`,
    );

    await enableNotionMirror({
      docoId: "doco_notion",
      tokens: { ...tokens, workspace_id: "ws-2", bot_id: "bot-2" },
      consentedBy: "user_owner",
    });

    expect((await dbm.db.query("SELECT 1 FROM notion_pages")).rows).toHaveLength(0);
    expect(await mirrorRow()).toMatchObject({ workspace_id: "ws-2" });
  });
});

describe("tokens, resync, stop", () => {
  beforeEach(async () => {
    await enableNotionMirror({ docoId: "doco_notion", tokens, consentedBy: "user_owner" });
  });

  it("stores a refreshed pair encrypted and clears the reauthorization flag", async () => {
    await markNotionMirrorNeedsReauth("doco_notion");
    await storeNotionTokens("doco_notion", { access_token: "ntn_new", refresh_token: null });

    const row = await mirrorRow();
    expect(isEncryptedSecret(row?.access_token ?? "")).toBe(true);
    expect(row).toMatchObject({ refresh_token: null, needs_reauth_at: null });
    expect(await getNotionTokens("doco_notion")).toEqual({
      accessToken: "ntn_new",
      refreshToken: null,
    });
  });

  it("has no tokens for a Doco that mirrors nothing", async () => {
    expect(await getNotionTokens("doco_other")).toBeNull();
  });

  it("re-sync clears the last discovery walk so the next tick walks again", async () => {
    await dbm.db.query(
      "UPDATE notion_mirrors SET discovered_at = now(), discovery_cursor = 'c' WHERE doco_id = 'doco_notion'",
    );
    await requestNotionResync("doco_notion");
    expect(await mirrorRow()).toMatchObject({ discovered_at: null });
  });

  it("stop deletes the mirror and its copy", async () => {
    await dbm.db.query(
      `INSERT INTO notion_pages (doco_id, page_id, object, url)
       VALUES ('doco_notion', 'p1', 'page', 'https://www.notion.so/p1')`,
    );
    await stopNotionMirror("doco_notion");
    expect(await mirrorRow()).toBeNull();
    expect((await dbm.db.query("SELECT 1 FROM notion_pages")).rows).toHaveLength(0);
  });
});

describe("loadNotionMirrorStatus", () => {
  it("is null for a Doco that mirrors nothing", async () => {
    expect(await loadNotionMirrorStatus("doco_other")).toBeNull();
  });

  it("counts discovered, copied, pending and parked pages", async () => {
    await enableNotionMirror({ docoId: "doco_notion", tokens, consentedBy: "user_owner" });
    await dbm.db.exec(`
      INSERT INTO notion_pages (doco_id, page_id, object, url, title, fetch_pending, fetch_error, synced_at) VALUES
        ('doco_notion', 'p1', 'page', 'https://www.notion.so/p1', 'Copied', false, NULL, now()),
        ('doco_notion', 'p2', 'page', 'https://www.notion.so/p2', 'Waiting', true, NULL, NULL),
        ('doco_notion', 'p3', 'page', 'https://www.notion.so/p3', 'Parked', false, 'restricted_resource', NULL);
      UPDATE notion_mirrors SET ticked_at = '2026-09-28T10:00:00Z' WHERE doco_id = 'doco_notion';
    `);

    expect(await loadNotionMirrorStatus("doco_notion")).toEqual({
      workspaceName: "Acme",
      workspaceIcon: "📓",
      authorizedBy: "Tania",
      consentedAt: expect.any(String),
      needsReauth: false,
      discoveredAt: null,
      tickedAt: "2026-09-28T10:00:00.000Z",
      pages: 3,
      synced: 1,
      pending: 1,
      parked: [
        {
          pageId: "p3",
          title: "Parked",
          url: "https://www.notion.so/p3",
          error: "restricted_resource",
        },
      ],
    });
  });
});
