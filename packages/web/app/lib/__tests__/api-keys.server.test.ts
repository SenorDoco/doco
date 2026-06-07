import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withClient: vi.fn(),
  getWorkspaceRole: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
  issueTokens: vi.fn(),
  registerClient: vi.fn(),
  assertSingleWorkspaceGrant: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: mocks.withClient,
  getWorkspaceRole: mocks.getWorkspaceRole,
  listWorkspacesForUser: mocks.listWorkspacesForUser,
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal: mocks.listAccessibleDocoIdsForPrincipal,
}));

vi.mock("~/lib/user-invite", () => ({
  ALL_ROLES: ["reader", "writer", "owner"],
  rankOf: (role: string) =>
    role === "owner" ? 3 : role === "writer" ? 2 : role === "writer" ? 1 : 0,
}));

vi.mock("~/lib/doco-labels", () => ({
  qualifiedDocoLabel: ({ ownerSlug, handle }: { ownerSlug: string; handle: string }) =>
    ownerSlug ? `${ownerSlug}/${handle}` : handle,
}));

vi.mock("~/lib/oauth-server.server", () => ({
  issueTokens: mocks.issueTokens,
  registerClient: mocks.registerClient,
  assertSingleWorkspaceGrant: mocks.assertSingleWorkspaceGrant,
}));

import { addGrantsToApiKey, listApiKeysForUser, mintApiKey } from "../api-keys.server";

describe("listApiKeysForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("labels OAuth tokens with the stored token name", async () => {
    mocks.withClient.mockImplementation(async (callback) =>
      callback({
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              client_id: "doco_client_agent",
              client_name: "Claude Code",
              token_name: "Repo Codex",
              user_id: "user_owner",
              user_kind: "person",
              user_login: "torrenegra",
              user_data: {},
              redirect_uris: ["http://127.0.0.1:4321/callback"],
              granted_doco_ids: [],
              granted_doco_roles: {},
              granted_workspace_ids: [],
              granted_workspace_roles: {},
              created_at: new Date("2026-05-27T12:00:00Z"),
              expires_at: new Date("2026-07-27T12:00:00Z"),
              last_seen_at: null,
            },
          ],
        }),
      }),
    );

    const keys = await listApiKeysForUser("user_owner");

    expect(keys).toEqual([
      expect.objectContaining({
        client_id: "doco_client_agent",
        client_name: "Repo Codex",
        source: "oauth",
      }),
    ]);
  });
});

describe("mintApiKey — actor token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerClient.mockResolvedValue({ client_id: "doco_client_actor" });
    mocks.issueTokens.mockResolvedValue({
      access_token: "doco_at_x",
      refresh_token: "doco_rt_y",
      token_type: "Bearer",
      expires_in: 3600,
      scope: null,
    });
  });

  it("mints with grant_type='actor' and NO explicit grants (breadth resolved live)", async () => {
    const minted = await mintApiKey({
      me: { id: "user_owner" } as never,
      label: "my roaming agent",
      grants: [],
      grantType: "actor",
    });

    expect(mocks.issueTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        grant_type: "actor",
        granted_doco_ids: [],
        granted_workspace_ids: [],
        user_id: "user_owner",
      }),
    );
    // No per-target grant machinery runs for an actor token.
    expect(mocks.assertSingleWorkspaceGrant).not.toHaveBeenCalled();
    expect(mocks.listWorkspacesForUser).not.toHaveBeenCalled();
    expect(minted.scope_grants).toEqual([]);
    expect(minted.refresh_token).toBe("doco_rt_y");
  });

  it("still requires a label", async () => {
    await expect(
      mintApiKey({
        me: { id: "user_owner" } as never,
        label: "  ",
        grants: [],
        grantType: "actor",
      }),
    ).rejects.toThrow(/label/i);
  });
});

describe("addGrantsToApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDocoLevelRole.mockResolvedValue("owner");
    mocks.getWorkspaceRole.mockResolvedValue("owner");
    mocks.assertSingleWorkspaceGrant.mockResolvedValue(undefined);
  });

  it("preserves untouched grants while replacing the target being modified", async () => {
    const queries = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("SELECT owner_id FROM docos")) {
        return { rows: [{ owner_id: "workspace_torre" }] };
      }
      if (sql.includes("FROM oauth_refresh_tokens")) {
        return {
          rows: [
            {
              client_id: "doco_client_existing",
              user_id: "user_agent",
              granted_doco_ids: ["doco_existing", "doco_untouched"],
              granted_doco_roles: { doco_existing: "reader", doco_untouched: "reader" },
              granted_doco_write_types: {
                doco_existing: ["decision"],
                doco_untouched: ["rule"],
              },
              granted_workspace_ids: [],
              granted_workspace_roles: {},
              granted_workspace_write_types: {},
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    mocks.withClient.mockImplementation(async (callback) => callback({ query: queries }));

    await addGrantsToApiKey({
      me: { id: "user_owner", username: "owner" } as never,
      client_id: "doco_client_existing",
      grants: [
        {
          level: "doco",
          target_id: "doco_existing",
          role: "reader",
          write_types: ["intent"],
        },
        {
          level: "doco",
          target_id: "doco_new",
          role: "writer",
          write_types: ["*"],
        },
      ],
    });

    const refreshUpdate = queries.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE oauth_refresh_tokens"),
    );
    const accessUpdate = queries.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE oauth_access_tokens"),
    );
    expect(refreshUpdate).toBeTruthy();
    expect(accessUpdate).toBeTruthy();

    const values = (refreshUpdate?.[1] ?? []) as unknown[];
    expect(values[1]).toEqual(["doco_existing", "doco_new", "doco_untouched"]);
    expect(JSON.parse(String(values[2]))).toEqual({
      doco_existing: "reader",
      doco_new: "writer",
      doco_untouched: "reader",
    });
    expect(JSON.parse(String(values[3]))).toEqual({
      doco_existing: ["intent"],
      doco_new: ["*"],
      doco_untouched: ["rule"],
    });
  });

  it("enforces the single-workspace invariant on the merged scope before updating", async () => {
    const queries = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT owner_id FROM docos")) {
        return { rows: [{ owner_id: "workspace_torre" }] };
      }
      if (sql.includes("FROM oauth_refresh_tokens")) {
        return {
          rows: [
            {
              client_id: "doco_client_existing",
              user_id: "user_owner",
              granted_doco_ids: ["doco_existing"],
              granted_doco_roles: { doco_existing: "reader" },
              granted_doco_write_types: {},
              granted_workspace_ids: ["workspace_torre"],
              granted_workspace_roles: { workspace_torre: "reader" },
              granted_workspace_write_types: {},
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    mocks.withClient.mockImplementation(async (callback) => callback({ query: queries }));
    // The invariant gate rejects the merged (cross-workspace) scope.
    mocks.assertSingleWorkspaceGrant.mockRejectedValue(
      new Error("A token can be scoped to at most one workspace."),
    );

    await expect(
      addGrantsToApiKey({
        me: { id: "user_owner", username: "owner" } as never,
        client_id: "doco_client_existing",
        grants: [{ level: "workspace", target_id: "workspace_other", role: "reader" }],
      }),
    ).rejects.toThrow(/at most one workspace/i);

    // The merged scope (both workspaces) is what's checked …
    expect(mocks.assertSingleWorkspaceGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        granted_workspace_ids: expect.arrayContaining(["workspace_torre", "workspace_other"]),
      }),
    );
    // … and nothing is persisted when the gate rejects.
    const updated = queries.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE oauth_"),
    );
    expect(updated).toBe(false);
  });
});
