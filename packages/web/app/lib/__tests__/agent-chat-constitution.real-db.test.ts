// Real-database exercise of the constitution making it into Señor Doco's
// system prompt. Points `@doco/db`'s `withClient` (and the
// constitution/workspace repo reads) at an in-process PGlite loaded with the
// REAL schema, so the reachability + scoping run against actual Postgres
// semantics (ANY($1::text[]), constitution <> '', the membership JOIN).
//
// This is the regression guard for the bug this whole change fixes: the
// sidebar agent used to omit the workspace constitution entirely. The model
// boundaries agent-chat.server pulls in are stubbed — no turn is driven.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentPrincipal } from "../session.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
  listAllDocos: async () => [],
  getDocoByIdOrHandle: async () => null,
  listWorkspacesForUser: async (userId: string, roles = ["owner", "writer", "reader"]) => {
    const r = await dbm.db.query<{
      id: string;
      handle: string;
      name: string;
      constitution: string;
    }>(
      `SELECT o.id, o.handle, o.name, o.constitution
         FROM workspaces o
         JOIN workspace_users m ON m.workspace_id = o.id
        WHERE m.user_id = $1 AND m.role = ANY($2::text[])
        ORDER BY o.handle`,
      [userId, roles],
    );
    return r.rows.map((row) => ({ ...row, member_count: 1 }));
  },
  getWorkspaceConstitutionsByIds: async (ids: string[]) => {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return [];
    const r = await dbm.db.query<{ id: string; handle: string; constitution: string }>(
      `SELECT id, handle, constitution
         FROM workspaces
        WHERE id = ANY($1::text[]) AND constitution <> ''
        ORDER BY handle`,
      [unique],
    );
    return r.rows.map((row) => ({
      workspace_id: String(row.id),
      workspace_handle: String(row.handle),
      constitution: String(row.constitution),
    }));
  },
}));
vi.mock("../doco-access.server", () => ({
  canAccessDoco: async () => true,
  oauthTokenGrantsDoco: () => true,
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
vi.mock("../internal-fetch.server", () => ({ internalFetch: vi.fn(async () => null) }));
vi.mock("../dotenv.server", () => ({ ensureEnvLoaded: vi.fn() }));
vi.mock("../telemetry.server", () => ({ upsertAgentTurn: vi.fn(async () => {}) }));

import {
  loadBootstrapForPrincipal,
  loadWorkspaceConstitutionsForPrincipal,
} from "../agent-bootstrap.server";
import {
  buildBootstrapContext,
  buildSystemBlocks,
  createConversation,
  listConversationsForPrincipal,
} from "../agent-chat.server";

const USER = "user_constitution000000000000";
const WS_REACHABLE = "workspace_reachable0000000000";
const WS_EMPTY = "workspace_emptyconst000000000";
const WS_UNREACHABLE = "workspace_unreachable000000000";

const CHARTER = "Ship small, reversible changes; write the decision down.";

const principal: CurrentPrincipal = {
  id: USER,
  username: "harness",
  type: "person",
  isHuman: true,
};

describe("Señor Doco bootstrap — workspace constitution", () => {
  beforeEach(async () => {
    dbm.db = new PGlite({ extensions: { vector } });
    await dbm.db.exec(schemaSql);
    await dbm.db.query("INSERT INTO users (id, data) VALUES ($1,'{}')", [USER]);
    // A workspace the user belongs to, with a non-empty charter.
    await dbm.db.query(
      "INSERT INTO workspaces (id, handle, name, constitution) VALUES ($1, $2, $3, $4)",
      [WS_REACHABLE, "acme", "Acme", CHARTER],
    );
    // A workspace the user belongs to but with NO charter — must not surface.
    await dbm.db.query(
      "INSERT INTO workspaces (id, handle, name, constitution) VALUES ($1, $2, $3, $4)",
      [WS_EMPTY, "beta", "Beta", ""],
    );
    // A workspace with a charter the user is NOT a member of — must not leak.
    await dbm.db.query(
      "INSERT INTO workspaces (id, handle, name, constitution) VALUES ($1, $2, $3, $4)",
      [WS_UNREACHABLE, "ghost", "Ghost", "Members only: never show this to outsiders."],
    );
    for (const ws of [WS_REACHABLE, WS_EMPTY]) {
      await dbm.db.query(
        "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
        [ws, USER],
      );
    }
  });

  it("includes the reachable workspace's charter, scoped to membership and non-empty", async () => {
    const bootstrap = await buildBootstrapContext(USER);
    const joined = bootstrap.constitutionSections.join("\n\n");
    expect(joined).toContain(CHARTER);
    expect(joined).toContain("acme");
    // Empty-charter membership and non-member workspaces never appear.
    expect(joined).not.toContain("Members only");
    expect(joined).not.toContain("beta");
  });

  it("renders the charter into the system prompt blocks", async () => {
    const bootstrap = await buildBootstrapContext(USER);
    const text = buildSystemBlocks(principal, bootstrap)
      .map((b) => b.text)
      .join("\n");
    expect(text).toContain(CHARTER);
    expect(text).not.toContain("Members only: never show this to outsiders.");
  });

  it("hands the sidebar the EXACT constitution set the external bootstrap manifest returns", async () => {
    // The whole point of the shared abstraction: Señor Doco and a connected
    // agent must never disagree on which constitutions apply.
    const sidebar = await loadWorkspaceConstitutionsForPrincipal(USER, null);
    const manifest = await loadBootstrapForPrincipal(USER, null);
    expect(sidebar).toEqual(manifest.workspaceConstitutions);
    expect(sidebar.map((w) => w.workspace_handle)).toEqual(["acme"]);
  });

  it("hard-scopes a thread to its workspace's charter — no cross-workspace leak", async () => {
    // A second reachable workspace with its own charter. A thread scoped to
    // one must see only that one's constitution, never the other's.
    const WS_DELTA = "workspace_deltacharter0000000";
    const DELTA_CHARTER = "Delta charter: write an ADR before you build.";
    await dbm.db.query(
      "INSERT INTO workspaces (id, handle, name, constitution) VALUES ($1, 'delta', 'Delta', $2)",
      [WS_DELTA, DELTA_CHARTER],
    );
    await dbm.db.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS_DELTA, USER],
    );

    const scopedToAcme = (
      await buildBootstrapContext(USER, WS_REACHABLE)
    ).constitutionSections.join("\n");
    expect(scopedToAcme).toContain(CHARTER);
    expect(scopedToAcme).not.toContain(DELTA_CHARTER);

    // Different memo key, fresh build — proves the per-workspace cache does not
    // leak Acme's charter into a Delta-scoped thread.
    const scopedToDelta = (await buildBootstrapContext(USER, WS_DELTA)).constitutionSections.join(
      "\n",
    );
    expect(scopedToDelta).toContain(DELTA_CHARTER);
    expect(scopedToDelta).not.toContain(CHARTER);
  });

  it("surfaces a thread's workspace handle for the sidebar tag", async () => {
    const conv = await createConversation(USER, { workspaceId: WS_REACHABLE });
    expect(conv.workspace_id).toBe(WS_REACHABLE);

    const [listed] = await listConversationsForPrincipal(USER);
    expect(listed.workspace_id).toBe(WS_REACHABLE);
    expect(listed.workspace_handle).toBe("acme");

    // An unassigned thread reports no workspace.
    const plain = await createConversation(USER);
    expect(plain.workspace_id).toBeNull();
  });

  it("flags an ambiguous unassigned thread and nudges Señor Doco to ask", async () => {
    // USER belongs to acme + beta (2 workspaces), so an unassigned thread is
    // ambiguous → the prompt must tell the agent to ask + set_thread_workspace.
    const broad = await buildBootstrapContext(USER);
    expect(broad.needsWorkspaceChoice).toBe(true);
    const broadText = buildSystemBlocks(principal, broad)
      .map((b) => b.text)
      .join("\n");
    expect(broadText).toContain("set_thread_workspace");
    expect(broadText).toMatch(/isn't scoped to a workspace yet/i);

    // A scoped thread carries no such nudge.
    const scoped = await buildBootstrapContext(USER, WS_REACHABLE);
    expect(scoped.needsWorkspaceChoice).toBe(false);
    const scopedText = buildSystemBlocks(principal, scoped)
      .map((b) => b.text)
      .join("\n");
    expect(scopedText).not.toContain("set_thread_workspace");
  });
});
