// Real-DB exercise of auto-scoping a Señor Doco thread to a Workspace when the
// choice is obvious. PGlite backs createConversation + the assignment UPDATE;
// listWorkspacesForUser and getDocoByIdOrHandle are stubbed (the doco lookup
// over a smart map, so we don't seed the full docos table). The model
// boundaries agent-chat.server pulls in are stubbed — no turn is driven.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({
  db: null as unknown as InstanceType<typeof PGlite>,
  // handle → owning workspace_id, for the getDocoByIdOrHandle stub.
  docoWorkspace: {} as Record<string, string>,
}));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
  listWorkspacesForUser: async (userId: string, roles = ["owner", "writer", "reader"]) => {
    const r = await dbm.db.query<{ id: string; handle: string; name: string }>(
      `SELECT o.id, o.handle, o.name
         FROM workspaces o
         JOIN workspace_users m ON m.workspace_id = o.id
        WHERE m.user_id = $1 AND m.role = ANY($2::text[])
        ORDER BY o.handle`,
      [userId, roles],
    );
    return r.rows.map((row) => ({ ...row, constitution: "", data: {}, member_count: 1 }));
  },
  getDocoByIdOrHandle: async (handle: string) => {
    const workspace_id = dbm.docoWorkspace[handle];
    return workspace_id ? { id: `doco_${handle}`, handle, workspace_id } : null;
  },
  getWorkspaceById: async (id: string) => {
    const r = await dbm.db.query<{ id: string; handle: string; name: string }>(
      "SELECT id, handle, name FROM workspaces WHERE id = $1",
      [id],
    );
    return r.rows[0] ? { ...r.rows[0], constitution: "", data: {}, member_count: 1 } : null;
  },
}));
vi.mock("../assistant-runtime.server", () => ({
  SENOR_DOCO_DEFAULT_MAX_TOKENS: 8192,
  getSenorDocoModel: () => "claude-test",
  missingSenorDocoAnthropicMessage: () => null,
  streamSenorDocoMessage: vi.fn(),
}));
vi.mock("../doco-api-tool.server", () => ({
  DOCO_API_TOOL: {
    name: "doco_api",
    description: "Call a Doco API route",
    input_schema: { type: "object", properties: {} },
  },
  runDocoApiToolRequest: vi.fn(),
}));
vi.mock("../senor-doco-prompt.server", () => ({ buildSenorDocoCorePrompt: () => "SYSTEM PROMPT" }));
vi.mock("../host.server", () => ({ listAllDocos: async () => [] }));
vi.mock("../doco-access.server", () => ({ canAccessDoco: async () => true }));
vi.mock("../internal-fetch.server", () => ({ internalFetch: vi.fn(async () => null) }));
vi.mock("../dotenv.server", () => ({ ensureEnvLoaded: vi.fn() }));
vi.mock("../telemetry.server", () => ({ upsertAgentTurn: vi.fn(async () => {}) }));

import {
  applySetThreadWorkspace,
  autoAssignThreadWorkspaceIfObvious,
  createConversation,
  loadConversationByIdForPrincipal,
  loadSnapshotForPrincipal,
} from "../agent-chat.server";

const USER = "user_assign000000000000000000";
const WS_A = "workspace_alpha00000000000000";
const WS_B = "workspace_beta000000000000000";

async function member(workspaceId: string, handle: string) {
  await dbm.db.query(
    "INSERT INTO workspaces (id, handle, name, constitution, data) VALUES ($1,$2,$3,'','{}')",
    [workspaceId, handle, handle],
  );
  await dbm.db.query(
    "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
    [workspaceId, USER],
  );
}

describe("autoAssignThreadWorkspaceIfObvious", () => {
  beforeEach(async () => {
    dbm.db = new PGlite();
    dbm.docoWorkspace = {};
    await dbm.db.exec(schemaSql);
    await dbm.db.query("INSERT INTO users (id, data) VALUES ($1,'{}')", [USER]);
  });

  it("scopes to the user's only Workspace (obvious — no page needed)", async () => {
    await member(WS_A, "alpha");
    const conv = await createConversation(USER);

    await autoAssignThreadWorkspaceIfObvious(conv, USER, null);

    expect(conv.workspace_id).toBe(WS_A);
    // Persisted, so later turns + the sidebar tag are scoped too.
    const reloaded = await loadConversationByIdForPrincipal(conv.id, USER);
    expect(reloaded?.workspace_id).toBe(WS_A);
  });

  it("scopes to the Workspace whose page the user is on", async () => {
    await member(WS_A, "alpha");
    await member(WS_B, "beta");
    const conv = await createConversation(USER);

    await autoAssignThreadWorkspaceIfObvious(conv, USER, "/workspaces/beta/settings");

    expect(conv.workspace_id).toBe(WS_B);
  });

  it("scopes to the Workspace owning the doco page the user is on", async () => {
    await member(WS_A, "alpha");
    await member(WS_B, "beta");
    dbm.docoWorkspace.bdoco = WS_B;
    const conv = await createConversation(USER);

    await autoAssignThreadWorkspaceIfObvious(conv, USER, "/bdoco/decision/decision_01");

    expect(conv.workspace_id).toBe(WS_B);
  });

  it("leaves the thread unassigned when it is genuinely ambiguous", async () => {
    await member(WS_A, "alpha");
    await member(WS_B, "beta");
    const conv = await createConversation(USER);

    await autoAssignThreadWorkspaceIfObvious(conv, USER, "/dashboard");

    expect(conv.workspace_id).toBeNull();
  });

  it("never clobbers a thread that is already scoped", async () => {
    await member(WS_A, "alpha");
    await member(WS_B, "beta");
    const conv = await createConversation(USER, { workspaceId: WS_A });

    await autoAssignThreadWorkspaceIfObvious(conv, USER, "/workspaces/beta");

    expect(conv.workspace_id).toBe(WS_A);
  });
});

describe("applySetThreadWorkspace (the set_thread_workspace tool)", () => {
  beforeEach(async () => {
    dbm.db = new PGlite();
    dbm.docoWorkspace = {};
    await dbm.db.exec(schemaSql);
    await dbm.db.query("INSERT INTO users (id, data) VALUES ($1,'{}')", [USER]);
    await member(WS_A, "alpha");
    await member(WS_B, "beta");
  });

  it("scopes the thread when the user names a workspace by id", async () => {
    const conv = await createConversation(USER);
    const out = await applySetThreadWorkspace(conv.id, USER, WS_A);
    expect(out.ok).toBe(true);
    expect((await loadConversationByIdForPrincipal(conv.id, USER))?.workspace_id).toBe(WS_A);
  });

  it("accepts a workspace handle too", async () => {
    const conv = await createConversation(USER);
    const out = await applySetThreadWorkspace(conv.id, USER, "beta");
    expect(out.ok).toBe(true);
    expect((await loadConversationByIdForPrincipal(conv.id, USER))?.workspace_id).toBe(WS_B);
  });

  it("refuses a workspace the user does not belong to, leaving the thread unchanged", async () => {
    const conv = await createConversation(USER);
    const out = await applySetThreadWorkspace(conv.id, USER, "workspace_outsider0000000000");
    expect(out.ok).toBe(false);
    expect((await loadConversationByIdForPrincipal(conv.id, USER))?.workspace_id).toBeNull();
  });

  it("can re-scope an already-assigned thread (explicit choice has no NULL guard)", async () => {
    const conv = await createConversation(USER, { workspaceId: WS_A });
    const out = await applySetThreadWorkspace(conv.id, USER, WS_B);
    expect(out.ok).toBe(true);
    expect((await loadConversationByIdForPrincipal(conv.id, USER))?.workspace_id).toBe(WS_B);
  });
});

describe("loadSnapshotForPrincipal — in-thread workspace tag", () => {
  beforeEach(async () => {
    dbm.db = new PGlite();
    dbm.docoWorkspace = {};
    await dbm.db.exec(schemaSql);
    await dbm.db.query("INSERT INTO users (id, data) VALUES ($1,'{}')", [USER]);
    await member(WS_A, "alpha");
  });

  it("carries the owning workspace handle so the chat header can tag it", async () => {
    const conv = await createConversation(USER, { workspaceId: WS_A });
    const snap = await loadSnapshotForPrincipal(USER, { conversationId: conv.id });
    expect(snap?.workspace_handle).toBe("alpha");
  });

  it("carries null for an unassigned thread (no tag)", async () => {
    const conv = await createConversation(USER);
    const snap = await loadSnapshotForPrincipal(USER, { conversationId: conv.id });
    expect(snap?.workspace_handle).toBeNull();
  });
});
