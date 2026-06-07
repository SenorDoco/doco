import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withClient: vi.fn(),
  withTransaction: vi.fn(),
  generateUlid: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: mocks.withClient,
  withTransaction: mocks.withTransaction,
}));

vi.mock("@doco/shared", () => ({
  generateUlid: mocks.generateUlid,
}));

import {
  type GrantSets,
  approveDeviceAuthorization,
  assertSingleWorkspaceGrant,
  consumeAuthorizationCode,
  issueAuthorizationCode,
  issueTokens,
  mergeGrantSets,
  normalizeTokenName,
  pollDeviceAuthorization,
  refreshTokens,
} from "../oauth-server.server";

/** Calls whose SQL contains `fragment`, in invocation order. */
function callsTo(fragment: string): unknown[][] {
  return mocks.query.mock.calls.filter((c) => String(c[0]).includes(fragment));
}

const emptyGrants: GrantSets = {
  granted_doco_ids: [],
  granted_doco_roles: {},
  granted_doco_write_types: {},
  granted_workspace_ids: [],
  granted_workspace_roles: {},
  granted_workspace_write_types: {},
};

describe("OAuth token authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateUlid.mockReturnValue("01AGENT0000000000000000000");
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (callback) =>
      callback({
        query: mocks.query,
      }),
    );
    mocks.withClient.mockImplementation(async (callback) =>
      callback({
        query: mocks.query,
      }),
    );
  });

  it("normalizes and requires a token name", () => {
    expect(normalizeTokenName("  Codex   in repo  ")).toBe("Codex in repo");
    expect(() => normalizeTokenName("   ")).toThrow(/token_name required/);
  });

  it("refreshTokens reissues the access token but keeps the same refresh token (non-rotating)", async () => {
    const refreshRow = {
      client_id: "doco_client_x",
      user_id: "user_a",
      token_name: "t",
      granted_doco_ids: ["doco_1"],
      granted_doco_roles: {},
      granted_doco_write_types: {},
      granted_workspace_ids: [],
      granted_workspace_roles: {},
      granted_workspace_write_types: {},
      scope: "doco",
      expires_at: new Date(Date.now() + 10_000_000),
      revoked: false,
    };
    mocks.query.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM oauth_refresh_tokens")
        ? { rows: [refreshRow], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    );

    const result = await refreshTokens({
      client_id: "doco_client_x",
      refresh_token: "doco_rt_original",
    });

    // Non-rotating: the same refresh token comes back, a fresh access token
    // is minted, no new refresh row is created, the old one is not revoked —
    // only its expiry slides forward.
    expect(result.refresh_token).toBe("doco_rt_original");
    expect(result.access_token).toMatch(/^doco_at_/);
    expect(callsTo("INSERT INTO oauth_refresh_tokens")).toHaveLength(0);
    expect(callsTo("SET revoked = true")).toHaveLength(0);
    expect(callsTo("UPDATE oauth_refresh_tokens SET expires_at")).toHaveLength(1);
  });

  const actorRefreshRow = {
    client_id: "doco_client_x",
    user_id: "user_a",
    token_name: "actor key",
    granted_doco_ids: [],
    granted_doco_roles: {},
    granted_doco_write_types: {},
    granted_workspace_ids: [],
    granted_workspace_roles: {},
    granted_workspace_write_types: {},
    grant_type: "actor",
    actor_role: null,
    scope: "doco",
    expires_at: new Date(Date.now() + 10_000_000),
    revoked: false,
  };

  it("an actor refresh mints an access token scoped to the resource workspace at the user's live role", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM oauth_refresh_tokens")) {
        return { rows: [actorRefreshRow], rowCount: 1 };
      }
      if (String(sql).includes("FROM workspace_users")) {
        return { rows: [{ role: "writer" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await refreshTokens({
      client_id: "doco_client_x",
      refresh_token: "doco_rt_actor",
      resource: "https://doco.to/workspace_a/mcp",
    });

    expect(result.access_token).toMatch(/^doco_at_/);
    const params = callsTo("INSERT INTO oauth_access_tokens")[0]?.[1] as unknown[];
    // granted_workspace_ids narrowed to the ONE requested workspace …
    expect(params[7]).toEqual(["workspace_a"]);
    // … carrying the user's live role in it (null actor_role = full role) …
    expect(JSON.parse(params[8] as string)).toEqual({ workspace_a: "writer" });
    // … and no doco grants leak through.
    expect(params[4]).toEqual([]);
  });

  it("an actor refresh caps the access-token role at actor_role (min with live role)", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM oauth_refresh_tokens")) {
        return { rows: [{ ...actorRefreshRow, actor_role: "reader" }], rowCount: 1 };
      }
      if (String(sql).includes("FROM workspace_users")) {
        return { rows: [{ role: "owner" }], rowCount: 1 }; // live role is higher
      }
      return { rows: [], rowCount: 1 };
    });

    await refreshTokens({
      client_id: "doco_client_x",
      refresh_token: "doco_rt_actor",
      resource: "https://doco.to/workspace_a/mcp",
    });

    const params = callsTo("INSERT INTO oauth_access_tokens")[0]?.[1] as unknown[];
    // The reader ceiling wins over the owner live role.
    expect(JSON.parse(params[8] as string)).toEqual({ workspace_a: "reader" });
  });

  it("an actor_role ceiling never RAISES the access role above the live role", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM oauth_refresh_tokens")) {
        return { rows: [{ ...actorRefreshRow, actor_role: "owner" }], rowCount: 1 };
      }
      if (String(sql).includes("FROM workspace_users")) {
        return { rows: [{ role: "writer" }], rowCount: 1 }; // live role is lower
      }
      return { rows: [], rowCount: 1 };
    });

    await refreshTokens({
      client_id: "doco_client_x",
      refresh_token: "doco_rt_actor",
      resource: "https://doco.to/workspace_a/mcp",
    });

    const params = callsTo("INSERT INTO oauth_access_tokens")[0]?.[1] as unknown[];
    // owner ceiling but you're only a writer here → writer, not owner.
    expect(JSON.parse(params[8] as string)).toEqual({ workspace_a: "writer" });
  });

  it("rejects an actor refresh that names no workspace (no broad access token)", async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM oauth_refresh_tokens")
        ? { rows: [actorRefreshRow], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    );

    await expect(
      refreshTokens({ client_id: "doco_client_x", refresh_token: "doco_rt_actor" }),
    ).rejects.toThrow(/resource/i);
    expect(callsTo("INSERT INTO oauth_access_tokens")).toHaveLength(0);
  });

  it("rejects an actor refresh for a workspace the user is not a member of", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM oauth_refresh_tokens")) {
        return { rows: [actorRefreshRow], rowCount: 1 };
      }
      if (String(sql).includes("FROM workspace_users")) {
        return { rows: [], rowCount: 0 }; // not a member
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      refreshTokens({
        client_id: "doco_client_x",
        refresh_token: "doco_rt_actor",
        resource: "https://doco.to/workspace_x/mcp",
      }),
    ).rejects.toThrow(/not a member/i);
    expect(callsTo("INSERT INTO oauth_access_tokens")).toHaveLength(0);
  });

  // The authorization-code exchange (issueTokens) must scope an actor token the
  // SAME way refresh does — otherwise the FIRST access token an MCP receives is
  // minted with the code's empty grants and reaches nothing.
  const actorIssueInput = {
    client_id: "doco_client_x",
    user_id: "user_a",
    token_name: "actor key",
    granted_doco_ids: [] as string[],
    granted_workspace_ids: [] as string[],
    scope: "doco" as string | null,
    grant_type: "actor" as const,
    actor_role: null as null | "reader" | "writer" | "owner",
  };

  it("an actor authorization-code exchange scopes the FIRST access token to the resource workspace at the live role", async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM workspace_users")
        ? { rows: [{ role: "writer" }], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    );

    const result = await issueTokens({
      ...actorIssueInput,
      resource: "https://doco.to/workspace_a/mcp",
    });

    expect(result.access_token).toMatch(/^doco_at_/);
    const access = callsTo("INSERT INTO oauth_access_tokens")[0]?.[1] as unknown[];
    // Scoped to the ONE requested workspace at the user's live role, no docos.
    expect(access[7]).toEqual(["workspace_a"]);
    expect(JSON.parse(access[8] as string)).toEqual({ workspace_a: "writer" });
    expect(access[4]).toEqual([]);
    // The refresh token keeps the deferred actor breadth (no stored grants).
    const refresh = callsTo("INSERT INTO oauth_refresh_tokens")[0]?.[1] as unknown[];
    expect(refresh[7]).toEqual([]);
    expect(refresh[12]).toBe("actor");
  });

  it("an actor authorization-code exchange caps the access role at actor_role", async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM workspace_users")
        ? { rows: [{ role: "owner" }], rowCount: 1 } // live role higher than the cap
        : { rows: [], rowCount: 1 },
    );

    await issueTokens({
      ...actorIssueInput,
      actor_role: "reader",
      resource: "https://doco.to/workspace_a/mcp",
    });

    const access = callsTo("INSERT INTO oauth_access_tokens")[0]?.[1] as unknown[];
    expect(JSON.parse(access[8] as string)).toEqual({ workspace_a: "reader" });
  });

  it("rejects an actor authorization-code exchange that names no workspace", async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(issueTokens({ ...actorIssueInput })).rejects.toThrow(/resource/i);
    expect(callsTo("INSERT INTO oauth_access_tokens")).toHaveLength(0);
  });

  it("rejects an actor authorization-code exchange for a workspace the user isn't in", async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM workspace_users")
        ? { rows: [], rowCount: 0 }
        : { rows: [], rowCount: 1 },
    );
    await expect(
      issueTokens({ ...actorIssueInput, resource: "https://doco.to/workspace_x/mcp" }),
    ).rejects.toThrow(/not a member/i);
    expect(callsTo("INSERT INTO oauth_access_tokens")).toHaveLength(0);
  });

  it("issues browser OAuth codes for the approving user and stores the token name", async () => {
    await issueAuthorizationCode({
      client_id: "doco_client_browser",
      approver_user_id: "user_owner",
      token_name: "  Claude   Code  ",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_challenge: "challenge",
      granted_doco_ids: ["doco_bpms"],
      granted_doco_roles: { doco_bpms: "writer" },
      granted_doco_write_types: { doco_bpms: ["decision"] },
      granted_workspace_ids: ["workspace_torre"],
      granted_workspace_roles: { workspace_torre: "reader" },
      granted_workspace_write_types: { workspace_torre: ["intent"] },
      scope: "doco",
    });

    expect(callsTo("kind = 'agent'")).toHaveLength(0);
    expect(callsTo("INSERT INTO users")).toHaveLength(0);
    expect(callsTo("INSERT INTO doco_users")).toHaveLength(0);
    expect(callsTo("INSERT INTO workspace_users")).toHaveLength(0);

    // The minted code carries the approving human id, token name, and the approved grants.
    const codeInsert = callsTo("INSERT INTO oauth_authorization_codes")[0];
    expect(codeInsert?.[1]).toEqual(expect.arrayContaining(["doco_client_browser", "user_owner"]));
    expect((codeInsert?.[1] as unknown[])[4]).toBe("Claude Code");
    expect((codeInsert?.[1] as unknown[])[6]).toEqual(["doco_bpms"]);
    expect(JSON.parse((codeInsert?.[1] as unknown[])[8] as string)).toEqual({
      doco_bpms: ["decision"],
    });
    expect(JSON.parse((codeInsert?.[1] as unknown[])[11] as string)).toEqual({
      workspace_torre: ["intent"],
    });
  });

  it("approves device codes by binding the pending grant to the approving user and token name", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT client_id")) {
        return { rows: [{ client_id: "doco_client_device" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await approveDeviceAuthorization({
      device_code: "doco_dc_123",
      approver_user_id: "user_owner",
      token_name: "Codex sandbox",
      granted_doco_ids: ["doco_bpms"],
      granted_doco_roles: { doco_bpms: "writer" },
      granted_doco_write_types: { doco_bpms: ["decision"] },
      granted_workspace_ids: [],
      granted_workspace_roles: {},
      granted_workspace_write_types: {},
    });

    expect(callsTo("INSERT INTO users")).toHaveLength(0);
    expect(callsTo("INSERT INTO doco_users")).toHaveLength(0);
    const update = callsTo("UPDATE oauth_device_authorizations")[0];
    expect(update?.[1]).toEqual(expect.arrayContaining(["doco_dc_123", "user_owner"]));
    expect((update?.[1] as unknown[])[2]).toBe("Codex sandbox");
  });

  it("re-authorizing a client records exactly the newly approved token grants", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT client_id")) {
        return { rows: [{ client_id: "doco_client_device" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await approveDeviceAuthorization({
      device_code: "doco_dc_123",
      approver_user_id: "user_owner",
      token_name: "Codex sandbox",
      granted_doco_ids: ["doco_new"],
      granted_doco_roles: { doco_new: "writer" },
      granted_doco_write_types: { doco_new: ["intent"] },
      granted_workspace_ids: [],
      granted_workspace_roles: {},
      granted_workspace_write_types: {},
    });

    // Tokens do not create or reuse agent users.
    expect(callsTo("kind = 'agent'")).toHaveLength(0);
    expect(callsTo("INSERT INTO users")).toHaveLength(0);
    expect(callsTo("INSERT INTO doco_users")).toHaveLength(0);

    // The device row is bound to the approving user and the approved set only.
    const update = callsTo("UPDATE oauth_device_authorizations")[0];
    expect((update?.[1] as unknown[])[1]).toBe("user_owner");
    expect((update?.[1] as unknown[])[3]).toEqual(["doco_new"]);
    const roles = JSON.parse((update?.[1] as unknown[])[4] as string);
    expect(roles).toEqual({ doco_new: "writer" });
    const writeTypes = JSON.parse((update?.[1] as unknown[])[5] as string);
    expect(writeTypes).toEqual({ doco_new: ["intent"] });
  });
});

// The consent screens can mint an "act as me" credential: grant_type='actor',
// no explicit grants, breadth resolved (one workspace per access token) at
// refresh time. These tests pin the value as it threads through the
// authorization-code and device-code paths.
describe("actor grant_type threads through the consent paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateUlid.mockReturnValue("01AGENT0000000000000000000");
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (callback) => callback({ query: mocks.query }));
    mocks.withClient.mockImplementation(async (callback) => callback({ query: mocks.query }));
  });

  it("issueAuthorizationCode persists grant_type (actor), defaulting to regular", async () => {
    await issueAuthorizationCode({
      client_id: "doco_client_browser",
      approver_user_id: "user_owner",
      token_name: "Claude",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_challenge: "challenge",
      granted_doco_ids: [],
      granted_workspace_ids: [],
      grant_type: "actor",
      actor_role: "reader",
      scope: "doco",
    });
    const actorInsert = callsTo("INSERT INTO oauth_authorization_codes")[0]?.[1] as unknown[];
    // …grant_type + actor_role land right after scope, before expires_at.
    expect(actorInsert[12]).toBe("doco"); // scope
    expect(actorInsert[13]).toBe("actor"); // grant_type
    expect(actorInsert[14]).toBe("reader"); // actor_role ceiling

    vi.clearAllMocks();
    await issueAuthorizationCode({
      client_id: "doco_client_browser",
      approver_user_id: "user_owner",
      token_name: "Claude",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_challenge: "challenge",
      granted_doco_ids: ["doco_bpms"],
      granted_workspace_ids: [],
      scope: "doco",
    });
    const regularInsert = callsTo("INSERT INTO oauth_authorization_codes")[0]?.[1] as unknown[];
    expect(regularInsert[13]).toBe("regular");
    expect(regularInsert[14]).toBeNull(); // no ceiling on a regular grant
  });

  it("consumeAuthorizationCode returns the stored grant_type", async () => {
    const verifier = "consume-test-verifier-0123456789";
    const code_challenge = createHash("sha256").update(verifier).digest("base64url");
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM oauth_authorization_codes")) {
        return {
          rows: [
            {
              client_id: "doco_client_browser",
              user_id: "user_owner",
              token_name: "Claude",
              redirect_uri: "http://127.0.0.1:4321/callback",
              code_challenge,
              granted_doco_ids: [],
              granted_doco_roles: {},
              granted_doco_write_types: {},
              granted_workspace_ids: [],
              granted_workspace_roles: {},
              granted_workspace_write_types: {},
              grant_type: "actor",
              actor_role: "writer",
              scope: "doco",
              expires_at: new Date(Date.now() + 10_000_000),
              consumed_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const claim = await consumeAuthorizationCode({
      code: "doco_code_actor",
      client_id: "doco_client_browser",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_verifier: verifier,
    });
    expect(claim.grant_type).toBe("actor");
    expect(claim.actor_role).toBe("writer"); // the stored ceiling rides back out
    expect(claim.granted_doco_ids).toEqual([]);
  });

  it("approveDeviceAuthorization persists grant_type + actor_role (actor)", async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes("SELECT client_id")
        ? { rows: [{ client_id: "doco_client_device" }], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    );

    await approveDeviceAuthorization({
      device_code: "doco_dc_123",
      approver_user_id: "user_owner",
      token_name: "Codex",
      granted_doco_ids: [],
      granted_workspace_ids: [],
      grant_type: "actor",
      actor_role: "writer",
    });
    const update = callsTo("UPDATE oauth_device_authorizations")[0]?.[1] as unknown[];
    expect(update[9]).toBe("actor"); // grant_type
    expect(update[10]).toBe("writer"); // actor_role ceiling, last in the SET list
  });

  it("pollDeviceAuthorization carries an actor grant_type into the minted refresh token", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM oauth_device_authorizations") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              device_code: "doco_dc_123",
              user_code: "WXYZ-1234",
              client_id: "doco_client_device",
              scope: "doco",
              status: "approved",
              user_id: "user_owner",
              token_name: "Codex",
              granted_doco_ids: [],
              granted_doco_roles: {},
              granted_doco_write_types: {},
              granted_workspace_ids: [],
              granted_workspace_roles: {},
              granted_workspace_write_types: {},
              grant_type: "actor",
              actor_role: "reader",
              target_doco_handle: null,
              requested_role: null,
              expires_at: new Date(Date.now() + 10_000_000),
              last_polled_at: null,
              created_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await pollDeviceAuthorization({
      device_code: "doco_dc_123",
      client_id: "doco_client_device",
    });
    expect(result.kind).toBe("approved");
    const refreshInsert = callsTo("INSERT INTO oauth_refresh_tokens")[0]?.[1] as unknown[];
    expect(refreshInsert[12]).toBe("actor"); // grant_type
    expect(refreshInsert[13]).toBe("reader"); // actor_role ceiling carried onto the refresh
  });
});

describe("single-workspace token invariant (assertSingleWorkspaceGrant)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateUlid.mockReturnValue("01AGENT0000000000000000000");
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (callback) => callback({ query: mocks.query }));
    mocks.withClient.mockImplementation(async (callback) => callback({ query: mocks.query }));
  });

  // Map a doco-id → owning workspace via the mocked `SELECT owner_id FROM docos`.
  function withDocoOwners(owners: Record<string, string>) {
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes("FROM docos")) {
        const ids = (params?.[0] as string[]) ?? [];
        return {
          rows: ids.filter((id) => owners[id]).map((id) => ({ owner_id: owners[id] })),
          rowCount: ids.length,
        };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it("allows a token scoped to exactly one workspace", async () => {
    await expect(
      assertSingleWorkspaceGrant({
        granted_doco_ids: [],
        granted_workspace_ids: ["workspace_a"],
      }),
    ).resolves.toBeUndefined();
  });

  it("allows a token scoped to docos that all live in one workspace", async () => {
    withDocoOwners({ doco_1: "workspace_a", doco_2: "workspace_a" });
    await expect(
      assertSingleWorkspaceGrant({
        granted_doco_ids: ["doco_1", "doco_2"],
        granted_workspace_ids: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("allows docos within the single granted workspace", async () => {
    withDocoOwners({ doco_1: "workspace_a" });
    await expect(
      assertSingleWorkspaceGrant({
        granted_doco_ids: ["doco_1"],
        granted_workspace_ids: ["workspace_a"],
      }),
    ).resolves.toBeUndefined();
  });

  it("allows personal (non-workspace) docos with no workspace grant", async () => {
    withDocoOwners({ doco_1: "user_alice" });
    await expect(
      assertSingleWorkspaceGrant({
        granted_doco_ids: ["doco_1"],
        granted_workspace_ids: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects the defer-scope '*' (full-access) token", async () => {
    await expect(
      assertSingleWorkspaceGrant({ granted_doco_ids: ["*"], granted_workspace_ids: [] }),
    ).rejects.toThrow(/full-access|single workspace/i);
  });

  it("rejects a token spanning two workspaces", async () => {
    await expect(
      assertSingleWorkspaceGrant({
        granted_doco_ids: [],
        granted_workspace_ids: ["workspace_a", "workspace_b"],
      }),
    ).rejects.toThrow(/at most one workspace/i);
  });

  it("rejects docos that live in different workspaces", async () => {
    withDocoOwners({ doco_1: "workspace_a", doco_2: "workspace_b" });
    await expect(
      assertSingleWorkspaceGrant({
        granted_doco_ids: ["doco_1", "doco_2"],
        granted_workspace_ids: [],
      }),
    ).rejects.toThrow(/at most one workspace/i);
  });

  it("rejects a doco whose workspace differs from the granted workspace", async () => {
    withDocoOwners({ doco_1: "workspace_b" });
    await expect(
      assertSingleWorkspaceGrant({
        granted_doco_ids: ["doco_1"],
        granted_workspace_ids: ["workspace_a"],
      }),
    ).rejects.toThrow(/at most one workspace/i);
  });

  it("issueAuthorizationCode rejects a cross-workspace grant", async () => {
    withDocoOwners({ doco_1: "workspace_b" });
    await expect(
      issueAuthorizationCode({
        client_id: "doco_client_x",
        approver_user_id: "user_owner",
        token_name: "broad",
        redirect_uri: "http://127.0.0.1:4321/callback",
        code_challenge: "challenge",
        granted_doco_ids: ["doco_1"],
        granted_workspace_ids: ["workspace_a"],
        scope: "doco",
      }),
    ).rejects.toThrow(/at most one workspace/i);
    expect(callsTo("INSERT INTO oauth_authorization_codes")).toHaveLength(0);
  });

  it("issueTokens rejects a defer-scope '*' grant", async () => {
    await expect(
      issueTokens({
        client_id: "doco_client_x",
        user_id: "user_owner",
        granted_doco_ids: ["*"],
        scope: null,
      }),
    ).rejects.toThrow(/full-access|single workspace/i);
    expect(callsTo("INSERT INTO oauth_access_tokens")).toHaveLength(0);
  });

  it("approveDeviceAuthorization rejects a two-workspace grant", async () => {
    await expect(
      approveDeviceAuthorization({
        device_code: "doco_dc_123",
        approver_user_id: "user_owner",
        token_name: "broad",
        granted_doco_ids: [],
        granted_workspace_ids: ["workspace_a", "workspace_b"],
      }),
    ).rejects.toThrow(/at most one workspace/i);
    expect(callsTo("UPDATE oauth_device_authorizations")).toHaveLength(0);
  });
});

describe("mergeGrantSets", () => {
  it("unions disjoint Doco and workspace grants", () => {
    const merged = mergeGrantSets(
      { ...emptyGrants, granted_doco_ids: ["a"], granted_doco_roles: { a: "reader" } },
      {
        ...emptyGrants,
        granted_doco_ids: ["b"],
        granted_doco_roles: { b: "writer" },
        granted_doco_write_types: { b: ["decision"] },
        granted_workspace_ids: ["workspace_x"],
        granted_workspace_roles: { workspace_x: "owner" },
      },
    );
    expect(merged.granted_doco_ids).toEqual(["a", "b"]);
    expect(merged.granted_doco_roles).toEqual({ a: "reader", b: "writer" });
    expect(merged.granted_doco_write_types).toEqual({ b: ["decision"] });
    expect(merged.granted_workspace_ids).toEqual(["workspace_x"]);
    expect(merged.granted_workspace_roles).toEqual({ workspace_x: "owner" });
  });

  it("keeps the STRONGER role when an id appears in both sets", () => {
    const merged = mergeGrantSets(
      { ...emptyGrants, granted_doco_ids: ["a"], granted_doco_roles: { a: "reader" } },
      { ...emptyGrants, granted_doco_ids: ["a"], granted_doco_roles: { a: "owner" } },
    );
    expect(merged.granted_doco_roles.a).toBe("owner");

    const merged2 = mergeGrantSets(
      { ...emptyGrants, granted_doco_ids: ["a"], granted_doco_roles: { a: "writer" } },
      { ...emptyGrants, granted_doco_ids: ["a"], granted_doco_roles: { a: "writer" } },
    );
    expect(merged2.granted_doco_roles.a).toBe("writer");
  });

  it("never drops an existing grant the incoming approval omits", () => {
    const merged = mergeGrantSets(
      {
        ...emptyGrants,
        granted_workspace_ids: ["workspace_x"],
        granted_workspace_roles: { workspace_x: "writer" },
      },
      emptyGrants,
    );
    expect(merged.granted_workspace_ids).toEqual(["workspace_x"]);
    expect(merged.granted_workspace_roles.workspace_x).toBe("writer");
  });
});
