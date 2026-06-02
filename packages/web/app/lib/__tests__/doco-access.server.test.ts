import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidAccessToken } from "../oauth-server.server";

const mocks = vi.hoisted(() => ({
  getAccountGrant: vi.fn(),
  getDocoUserGrant: vi.fn(),
  getWorkspaceGrant: vi.fn(),
  getPrincipalById: vi.fn(),
  listDocoIdsForUser: vi.fn(),
  listWorkspaceOwnerUserIds: vi.fn(),
  query: vi.fn(),
  validateAccessToken: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => {
  const rank = (role: "owner" | "writer" | "reader" | null | undefined) =>
    role === "owner" ? 2 : role === "writer" ? 1 : role === "reader" ? 0 : -1;
  return {
    getAccountGrant: mocks.getAccountGrant,
    getDocoByIdOrHandle: vi.fn(),
    getDocoUserGrant: mocks.getDocoUserGrant,
    getDocoUserRole: vi.fn(),
    getWorkspaceGrant: mocks.getWorkspaceGrant,
    getWorkspaceRole: vi.fn(),
    getPrincipalById: mocks.getPrincipalById,
    isWorkspaceUser: vi.fn(),
    listDocoIdsForUser: mocks.listDocoIdsForUser,
    listWorkspaceOwnerUserIds: mocks.listWorkspaceOwnerUserIds,
    maxRole: (...roles: ("owner" | "writer" | "reader" | null | undefined)[]) =>
      roles.reduce<"owner" | "writer" | "reader" | null>(
        (best, role) => (rank(role) > rank(best) ? (role ?? null) : best),
        null,
      ),
    roleAtLeast: (
      role: "owner" | "writer" | "reader" | null | undefined,
      threshold: "owner" | "writer" | "reader",
    ) => rank(role) >= rank(threshold),
    withClient: mocks.withClient,
  };
});

vi.mock("../oauth-server.server", () => ({
  validateAccessToken: mocks.validateAccessToken,
}));

import {
  canWriteDocoTypeForRequest,
  filterDocosToWorkspaceBoundary,
  listVisibleDocoIdsForRequest,
  oauthTokenGrantsDoco,
  tokenReachableWorkspaceIdsForRequest,
  tokenReachableWorkspaceIdsFromGrant,
} from "../doco-access.server";

function token(overrides: Partial<ValidAccessToken>): ValidAccessToken {
  return {
    token: "doco_at_x",
    client_id: "doco_client_x",
    client_name: "Test client",
    user_id: "principal_X",
    token_name: null,
    granted_doco_ids: [],
    granted_doco_roles: {},
    granted_doco_write_types: {},
    granted_workspace_ids: [],
    granted_workspace_roles: {},
    granted_workspace_write_types: {},
    scope: null,
    expires_at: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAccountGrant.mockResolvedValue(null);
  mocks.getDocoUserGrant.mockResolvedValue(null);
  mocks.getWorkspaceGrant.mockResolvedValue(null);
  mocks.getPrincipalById.mockResolvedValue(null);
  mocks.listWorkspaceOwnerUserIds.mockResolvedValue([]);
  mocks.validateAccessToken.mockResolvedValue(null);
  mocks.listDocoIdsForUser.mockResolvedValue([]);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.withClient.mockImplementation(async (fn: (c: { query: typeof mocks.query }) => unknown) =>
    fn({ query: mocks.query }),
  );
});

describe("oauthTokenGrantsDoco", () => {
  const workspaceOwned = { ownerId: "workspace_A", docoId: "doco_1" };
  const principalOwned = { ownerId: "principal_USER", docoId: "doco_2" };

  it("matches when the Doco id is in granted_doco_ids", () => {
    const t = token({ granted_doco_ids: ["doco_1"] });
    expect(oauthTokenGrantsDoco(t, workspaceOwned)).toBe(true);
  });

  it("matches when an workspace-owned Doco's owner is in granted_workspace_ids", () => {
    const t = token({ granted_workspace_ids: ["workspace_A"] });
    expect(oauthTokenGrantsDoco(t, workspaceOwned)).toBe(true);
  });

  it("rejects when neither the Doco nor its owner workspace is granted", () => {
    const t = token({
      granted_doco_ids: ["doco_other"],
      granted_workspace_ids: ["workspace_other"],
    });
    expect(oauthTokenGrantsDoco(t, workspaceOwned)).toBe(false);
  });

  it("does not let a personal-Principal-owned Doco match an workspace grant", () => {
    // The leak this regression-guards: an workspace grant must not extend
    // to Docos owned directly by a Principal (even one who happens to
    // belong to the granted workspace).
    const t = token({ granted_workspace_ids: ["workspace_A"] });
    expect(oauthTokenGrantsDoco(t, principalOwned)).toBe(false);
  });

  it("rejects when both grant lists are empty", () => {
    const t = token({});
    expect(oauthTokenGrantsDoco(t, workspaceOwned)).toBe(false);
    expect(oauthTokenGrantsDoco(t, principalOwned)).toBe(false);
  });
});

describe("canWriteDocoTypeForRequest token caps", () => {
  it("treats a writer-scoped token with no per-type map as write-all", async () => {
    mocks.getDocoUserGrant.mockResolvedValue({ role: "writer", writeTypes: ["*"] });
    mocks.validateAccessToken.mockResolvedValue(
      token({
        granted_doco_ids: ["doco_1"],
        granted_doco_roles: { doco_1: "writer" },
      }),
    );

    const request = new Request("https://doco.test/acme/api/principals.json", {
      headers: { Authorization: "Bearer doco_at_x" },
    });

    await expect(
      canWriteDocoTypeForRequest(
        request,
        { ownerId: "workspace_A", docoId: "doco_1" },
        "user_agent",
        "principal",
      ),
    ).resolves.toBe(true);
  });
});

describe("tokenReachableWorkspaceIdsFromGrant", () => {
  it("unions granted workspace ids with the workspaces that own granted Docos", () => {
    const t = token({
      granted_workspace_ids: ["workspace_meta"],
      granted_doco_ids: ["doco_torre1"],
    });
    const owners = new Map([["doco_torre1", "workspace_torre"]]);
    expect([...tokenReachableWorkspaceIdsFromGrant(t, owners)].sort()).toEqual([
      "workspace_meta",
      "workspace_torre",
    ]);
  });

  it("ignores granted Docos owned by a principal (no workspace to reach)", () => {
    const t = token({ granted_doco_ids: ["doco_personal"] });
    const owners = new Map([["doco_personal", "principal_alice"]]);
    expect([...tokenReachableWorkspaceIdsFromGrant(t, owners)]).toEqual([]);
  });
});

describe("filterDocosToWorkspaceBoundary", () => {
  // Alice belongs to two workspaces and owns a personal Doco.
  const owners = new Map<string, string>([
    ["doco_torre1", "workspace_torre"],
    ["doco_torre2", "workspace_torre"],
    ["doco_meta1", "workspace_meta"],
    ["doco_personal", "principal_alice"],
  ]);
  const accessible = ["doco_torre1", "doco_torre2", "doco_meta1", "doco_personal"];

  it("a Doco-scoped token sees same-workspace siblings but not other workspaces", () => {
    // The screenshot bug: a token scoped to one Doco in workspace torre must
    // not surface meta-doco's Docos, even though the human is in both.
    const t = token({ granted_doco_ids: ["doco_torre1"] });
    expect(filterDocosToWorkspaceBoundary(accessible, owners, t)).toEqual([
      "doco_torre1",
      "doco_torre2",
    ]);
  });

  it("an workspace-scoped token sees only that workspace's Docos", () => {
    const t = token({ granted_workspace_ids: ["workspace_meta"] });
    expect(filterDocosToWorkspaceBoundary(accessible, owners, t)).toEqual(["doco_meta1"]);
  });

  it("a Doco individually granted in another workspace is still listed", () => {
    const t = token({ granted_doco_ids: ["doco_torre1", "doco_meta1"] });
    expect(filterDocosToWorkspaceBoundary(accessible, owners, t)).toEqual([
      "doco_torre1",
      "doco_torre2",
      "doco_meta1",
    ]);
  });

  it("an workspace grant never surfaces a personal (principal-owned) Doco", () => {
    const t = token({ granted_workspace_ids: ["workspace_torre"] });
    expect(filterDocosToWorkspaceBoundary(accessible, owners, t)).toEqual([
      "doco_torre1",
      "doco_torre2",
    ]);
  });

  it("a token granting nothing sees nothing", () => {
    const t = token({});
    expect(filterDocosToWorkspaceBoundary(accessible, owners, t)).toEqual([]);
  });
});

describe("listVisibleDocoIdsForRequest", () => {
  // The principal (Alice) belongs to two workspaces; workspace membership surfaces
  // one Doco from each via `listAccessibleDocoIdsForPrincipal`.
  function dbReturns(viaWorkspaceDocoIds: string[], ownerRows: { id: string; owner_id: string }[]) {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("workspace_users"))
        return { rows: viaWorkspaceDocoIds.map((id) => ({ id })) };
      if (sql.includes("id, owner_id FROM docos")) return { rows: ownerRows };
      return { rows: [] }; // direct-ownership query
    });
  }

  it("narrows an OAuth token to its workspace boundary (the cross-workspace leak fix)", async () => {
    dbReturns(
      ["doco_torre1", "doco_meta1"],
      [
        { id: "doco_torre1", owner_id: "workspace_torre" },
        { id: "doco_meta1", owner_id: "workspace_meta" },
      ],
    );
    mocks.validateAccessToken.mockResolvedValue(token({ granted_doco_ids: ["doco_torre1"] }));
    const request = new Request("https://doco.test/api/v1/docos.json", {
      headers: { Authorization: "Bearer doco_at_x" },
    });
    await expect(listVisibleDocoIdsForRequest(request, "user_alice")).resolves.toEqual([
      "doco_torre1",
    ]);
  });

  it("returns the full principal set for a cookie session (no bearer)", async () => {
    dbReturns(
      ["doco_torre1", "doco_meta1"],
      [
        { id: "doco_torre1", owner_id: "workspace_torre" },
        { id: "doco_meta1", owner_id: "workspace_meta" },
      ],
    );
    const request = new Request("https://doco.test/api/v1/docos.json");
    await expect(listVisibleDocoIdsForRequest(request, "user_alice")).resolves.toEqual([
      "doco_torre1",
      "doco_meta1",
    ]);
    expect(mocks.validateAccessToken).not.toHaveBeenCalled();
  });
});

describe("tokenReachableWorkspaceIdsForRequest", () => {
  it("returns null without a bearer (no token scope-down to apply)", async () => {
    const request = new Request("https://doco.test/api/v1/workspaces.json");
    await expect(tokenReachableWorkspaceIdsForRequest(request)).resolves.toBeNull();
  });

  it("unions granted-doco workspaces with granted workspace ids", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("id, owner_id FROM docos")) {
        return { rows: [{ id: "doco_torre1", owner_id: "workspace_torre" }] };
      }
      return { rows: [] };
    });
    mocks.validateAccessToken.mockResolvedValue(
      token({ granted_workspace_ids: ["workspace_meta"], granted_doco_ids: ["doco_torre1"] }),
    );
    const request = new Request("https://doco.test/api/v1/workspaces.json", {
      headers: { Authorization: "Bearer doco_at_x" },
    });
    const reachable = await tokenReachableWorkspaceIdsForRequest(request);
    expect(reachable && [...reachable].sort()).toEqual(["workspace_meta", "workspace_torre"]);
  });
});

describe('legacy defer-scope ("*") token grants nothing now', () => {
  // The "*" full-access token was removed (single-workspace rule). Issuance
  // rejects it and the migration revokes any survivor, but defensively a "*"
  // is now treated as a literal id that matches no Doco — never a wildcard.
  it("does not grant an arbitrary Doco via the scope gate", () => {
    const t = token({ granted_doco_ids: ["*"] });
    expect(oauthTokenGrantsDoco(t, { ownerId: "workspace_A", docoId: "doco_anything" })).toBe(
      false,
    );
  });

  it("enumerates nothing through the workspace boundary", () => {
    const owners = new Map([["doco_torre1", "workspace_torre"]]);
    expect(
      filterDocosToWorkspaceBoundary(["doco_torre1"], owners, token({ granted_doco_ids: ["*"] })),
    ).toEqual([]);
  });
});
