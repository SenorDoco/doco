// Real-DB exercise of per-Doco Señor Doco chats. Every in-app chat is bound to
// exactly one Doco (1:1 per user): opening Señor Doco while viewing a Doco
// starts/opens that Doco's chat. PGlite backs createConversation, the
// get-or-create path, the snapshot, and the list. The Doco/workspace lookups
// in @doco/db are implemented against the same PGlite so the real SQL runs;
// the model boundaries agent-chat.server pulls in are stubbed (no turn driven).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({
  db: null as unknown as InstanceType<typeof PGlite>,
  canAccess: true,
}));

async function selectDoco(ref: string) {
  const r = await dbm.db.query<{
    id: string;
    handle: string;
    owner_id: string;
    workspace_id: string;
    visibility: string;
    owner_slug: string;
  }>(
    `SELECT d.id, d.handle, d.owner_id, d.workspace_id, d.visibility,
            COALESCE(u.github_login, w.handle, '') AS owner_slug
       FROM docos d
       LEFT JOIN users u ON u.id = d.owner_id
       LEFT JOIN workspaces w ON w.id = d.owner_id
      WHERE d.id = $1 OR d.handle = $1
      LIMIT 1`,
    [ref],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, goal: "", data: {}, default_node_lifecycle: null };
}

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
  getWorkspaceById: async (id: string) => {
    const r = await dbm.db.query<{ id: string; handle: string; name: string }>(
      "SELECT id, handle, name FROM workspaces WHERE id = $1",
      [id],
    );
    return r.rows[0] ? { ...r.rows[0], constitution: "", data: {}, member_count: 1 } : null;
  },
  getDocoById: async (id: string) => selectDoco(id),
  getDocoByIdOrHandle: async (ref: string) => selectDoco(ref),
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
vi.mock("../doco-access.server", () => ({ canAccessDoco: async () => dbm.canAccess }));
vi.mock("../internal-fetch.server", () => ({ internalFetch: vi.fn(async () => null) }));
vi.mock("../dotenv.server", () => ({ ensureEnvLoaded: vi.fn() }));
vi.mock("../telemetry.server", () => ({ upsertAgentTurn: vi.fn(async () => {}) }));

import {
  createConversation,
  listConversationsForPrincipal,
  loadOrCreateConversationForDoco,
  loadSnapshotForPrincipal,
} from "../agent-chat.server";

const USER = "user_docoscope0000000000000000";
const WS = "workspace_scope00000000000000";
const DOCO = "doco_scope0000000000000000000";

async function seedDoco(handle: string, docoId = DOCO, workspaceId = WS) {
  await dbm.db.query(
    "INSERT INTO workspaces (id, handle, name, constitution) VALUES ($1, 'scopews', 'scopews', '') ON CONFLICT (id) DO NOTHING",
    [workspaceId],
  );
  await dbm.db.query(
    "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING",
    [workspaceId, USER],
  );
  await dbm.db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data)
     VALUES ($1,$2,$3,$3,'private','{}')`,
    [docoId, handle, workspaceId],
  );
}

beforeEach(async () => {
  dbm.db = new PGlite();
  dbm.canAccess = true;
  await dbm.db.exec(schemaSql);
  await dbm.db.query("INSERT INTO users (id, data) VALUES ($1,'{}')", [USER]);
});

describe("createConversation with a Doco", () => {
  it("binds the thread to the Doco and derives its workspace", async () => {
    await seedDoco("billing");
    const conv = await createConversation(USER, { docoId: DOCO });
    expect(conv.doco_id).toBe(DOCO);
    // workspace_id is derived from the Doco so the existing workspace-scoped
    // bootstrap keeps working without a separate assignment step.
    expect(conv.workspace_id).toBe(WS);
  });
});

describe("loadOrCreateConversationForDoco — one chat per (user, Doco)", () => {
  it("creates the Doco's chat on first open", async () => {
    await seedDoco("billing");
    const conv = await loadOrCreateConversationForDoco(USER, DOCO);
    expect(conv.doco_id).toBe(DOCO);
    expect(conv.workspace_id).toBe(WS);
  });

  it("returns the same chat on a second open (never a duplicate)", async () => {
    await seedDoco("billing");
    const first = await loadOrCreateConversationForDoco(USER, DOCO);
    const second = await loadOrCreateConversationForDoco(USER, DOCO);
    expect(second.id).toBe(first.id);
  });

  it("revives the Doco's archived chat instead of minting a second", async () => {
    await seedDoco("billing");
    const first = await loadOrCreateConversationForDoco(USER, DOCO);
    await dbm.db.query("UPDATE chat_conversations SET archived = true WHERE id = $1", [first.id]);
    const second = await loadOrCreateConversationForDoco(USER, DOCO);
    expect(second.id).toBe(first.id);
    expect(second.archived).toBe(false);
  });
});

describe("loadSnapshotForPrincipal — by Doco (lazy, no empty rows)", () => {
  it("returns the Doco's display fields with no conversation before the first message", async () => {
    await seedDoco("billing");
    const snap = await loadSnapshotForPrincipal(USER, { docoRef: "billing" });
    expect(snap).not.toBeNull();
    expect(snap?.conversation_id).toBeNull();
    expect(snap?.doco_id).toBe(DOCO);
    expect(snap?.doco_handle).toBe("billing");
    expect(snap?.doco_owner_slug).toBe("scopews");
    expect(snap?.messages).toEqual([]);
    // Lazy: opening the Doco must not mint a row.
    const count = await dbm.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM chat_conversations",
    );
    expect(count.rows[0].n).toBe("0");
  });

  it("returns the existing chat once one exists for the Doco", async () => {
    await seedDoco("billing");
    const conv = await loadOrCreateConversationForDoco(USER, DOCO);
    const snap = await loadSnapshotForPrincipal(USER, { docoRef: "billing" });
    expect(snap?.conversation_id).toBe(conv.id);
    expect(snap?.doco_handle).toBe("billing");
  });

  it("returns null when the Doco is not reachable (no existence leak)", async () => {
    await seedDoco("billing");
    dbm.canAccess = false;
    const snap = await loadSnapshotForPrincipal(USER, { docoRef: "billing" });
    expect(snap).toBeNull();
  });

  it("returns null when the Doco does not exist", async () => {
    const snap = await loadSnapshotForPrincipal(USER, { docoRef: "ghost" });
    expect(snap).toBeNull();
  });
});

describe("listConversationsForPrincipal — Doco tag fields", () => {
  it("carries the Doco handle + owner slug so the row can link to it", async () => {
    await seedDoco("billing");
    await loadOrCreateConversationForDoco(USER, DOCO);
    const list = await listConversationsForPrincipal(USER);
    expect(list).toHaveLength(1);
    expect(list[0].doco_id).toBe(DOCO);
    expect(list[0].doco_handle).toBe("billing");
    expect(list[0].doco_owner_slug).toBe("scopews");
  });
});
