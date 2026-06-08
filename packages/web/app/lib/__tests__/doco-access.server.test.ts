import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidAccessToken } from "../oauth-server.server";

const mocks = vi.hoisted(() => ({
  getDocoUserGrant: vi.fn(),
  getWorkspaceGrant: vi.fn(),
  getPrincipalById: vi.fn(),
  listDocoIdsForUser: vi.fn(),
  query: vi.fn(),
  validateAccessToken: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => {
  const rank = (role: "owner" | "writer" | "reader" | null | undefined) =>
    role === "owner" ? 2 : role === "writer" ? 1 : role === "reader" ? 0 : -1;
  return {
    getDocoByIdOrHandle: vi.fn(),
    getDocoUserGrant: mocks.getDocoUserGrant,
    getDocoUserRole: vi.fn(),
    getWorkspaceGrant: mocks.getWorkspaceGrant,
    getWorkspaceRole: vi.fn(),
    getPrincipalById: mocks.getPrincipalById,
    isWorkspaceUser: vi.fn(),
    listDocoIdsForUser: mocks.listDocoIdsForUser,
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
  SENOR_DOCO_ROLE_CEILING,
  canAdminDocoForRequest,
  canWriteDocoTypeForRequest,
  capRoleForRequest,
  filterDocosToWorkspaceBoundary,
  getDocoLevelRoleForRequest,
  isSenorDocoRequest,
  listAccessibleDocoIdsInWorkspace,
  listVisibleDocoIdsForRequest,
  oauthTokenGrantsDoco,
  tokenReachableWorkspaceIdsForRequest,
  tokenReachableWorkspaceIdsFromGrant,
} from "../doco-access.server";

/** A request marked as coming from Señor Doco (web or Slack). */
function senorDocoRequest(surface = "senor-doco-web"): Request {
  return new Request("https://doco.test/acme/api/policies.json", {
    headers: { "x-doco-authoring-surface": surface },
  });
}

/** A plain human/browser request (no agent marker). */
function humanRequest(): Request {
  return new Request("https://doco.test/acme/api/policies.json");
}

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
    grant_type: "regular",
    actor_role: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDocoUserGrant.mockResolvedValue(null);
  mocks.getWorkspaceGrant.mockResolvedValue(null);
  mocks.getPrincipalById.mockResolvedValue(null);
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

describe("isSenorDocoRequest", () => {
  it("detects the web in-page assistant via the authoring-surface header", () => {
    expect(isSenorDocoRequest(senorDocoRequest("senor-doco-web"))).toBe(true);
  });

  it("detects the Slack assistant via the authoring-surface header", () => {
    expect(isSenorDocoRequest(senorDocoRequest("slack"))).toBe(true);
  });

  it("detects either assistant via the user-agent fallback", () => {
    const web = new Request("https://doco.test/x", {
      headers: { "user-agent": "Doco-In-Page-Assistant/1" },
    });
    const slack = new Request("https://doco.test/x", {
      headers: { "user-agent": "Doco-Slack-Assistant/1" },
    });
    expect(isSenorDocoRequest(web)).toBe(true);
    expect(isSenorDocoRequest(slack)).toBe(true);
  });

  it("is false for humans, MCP clients, and external API callers", () => {
    expect(isSenorDocoRequest(humanRequest())).toBe(false);
    expect(isSenorDocoRequest(senorDocoRequest("mcp"))).toBe(false);
    expect(isSenorDocoRequest(senorDocoRequest("website"))).toBe(false);
  });
});

describe("capRoleForRequest", () => {
  it("caps owner to the ceiling (writer) for a Señor Doco request", () => {
    expect(capRoleForRequest("owner", senorDocoRequest())).toBe("writer");
    expect(SENOR_DOCO_ROLE_CEILING).toBe("writer");
  });

  it("leaves owner intact for a non-agent request", () => {
    expect(capRoleForRequest("owner", humanRequest())).toBe("owner");
  });

  it("never raises a lower role and passes null through", () => {
    expect(capRoleForRequest("writer", senorDocoRequest())).toBe("writer");
    expect(capRoleForRequest("reader", senorDocoRequest())).toBe("reader");
    expect(capRoleForRequest(null, senorDocoRequest())).toBeNull();
  });
});

describe("getDocoLevelRoleForRequest", () => {
  const meta = { ownerId: "workspace_A", docoId: "doco_1" };

  beforeEach(() => {
    // The underlying human is an owner of this Doco.
    mocks.getDocoUserGrant.mockResolvedValue({ role: "owner", writeTypes: [] });
  });

  it("caps an owner principal to writer when the caller is Señor Doco", async () => {
    await expect(getDocoLevelRoleForRequest(senorDocoRequest(), meta, "user_owner")).resolves.toBe(
      "writer",
    );
  });

  it("returns the real owner role for a human request", async () => {
    await expect(getDocoLevelRoleForRequest(humanRequest(), meta, "user_owner")).resolves.toBe(
      "owner",
    );
  });
});

describe("actor token acts as the human, capped at actor_role", () => {
  const meta = { ownerId: "workspace_A", docoId: "doco_1" };
  function actorReq(): Request {
    return new Request("https://doco.test/acme/api/x.json", {
      headers: { Authorization: "Bearer doco_at_x" },
    });
  }

  it("oauthTokenGrantsDoco is true for any Doco (it acts as the human)", () => {
    const t = token({ grant_type: "actor", actor_role: null });
    expect(oauthTokenGrantsDoco(t, { ownerId: "workspace_other", docoId: "doco_zzz" })).toBe(true);
  });

  it("caps the human's live role at actor_role", async () => {
    mocks.getDocoUserGrant.mockResolvedValue({ role: "owner", writeTypes: [] });
    mocks.validateAccessToken.mockResolvedValue(
      token({ grant_type: "actor", actor_role: "reader", user_id: "user_owner" }),
    );
    await expect(getDocoLevelRoleForRequest(actorReq(), meta, "user_owner")).resolves.toBe(
      "reader",
    );
  });

  it("a null actor_role is full owner (no cap)", async () => {
    mocks.getDocoUserGrant.mockResolvedValue({ role: "owner", writeTypes: [] });
    mocks.validateAccessToken.mockResolvedValue(
      token({ grant_type: "actor", actor_role: null, user_id: "user_owner" }),
    );
    await expect(getDocoLevelRoleForRequest(actorReq(), meta, "user_owner")).resolves.toBe("owner");
  });

  it("never RAISES above the human's live role", async () => {
    mocks.getDocoUserGrant.mockResolvedValue({ role: "reader", writeTypes: [] });
    mocks.validateAccessToken.mockResolvedValue(
      token({ grant_type: "actor", actor_role: "owner", user_id: "user_reader" }),
    );
    // owner ceiling, but the human is only a reader here → reader.
    await expect(getDocoLevelRoleForRequest(actorReq(), meta, "user_reader")).resolves.toBe(
      "reader",
    );
  });

  it("enumerates the full live set, not a token boundary", async () => {
    // No stored grants on the actor token, yet listing returns everything the
    // human can reach (the cross-workspace narrowing is skipped for actor).
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes("workspace_users")
        ? { rows: [{ id: "doco_torre1" }, { id: "doco_meta1" }] }
        : { rows: [] },
    );
    mocks.validateAccessToken.mockResolvedValue(token({ grant_type: "actor", actor_role: null }));
    await expect(listVisibleDocoIdsForRequest(actorReq(), "user_alice")).resolves.toEqual([
      "doco_torre1",
      "doco_meta1",
    ]);
  });
});

describe("canAdminDocoForRequest", () => {
  const meta = { ownerId: "workspace_A", docoId: "doco_1" };

  beforeEach(() => {
    mocks.getDocoUserGrant.mockResolvedValue({ role: "owner", writeTypes: [] });
  });

  it("denies admin to Señor Doco even when the human is the Doco's owner", async () => {
    await expect(canAdminDocoForRequest(senorDocoRequest(), meta, "user_owner")).resolves.toBe(
      false,
    );
  });

  it("allows admin for a human owner", async () => {
    await expect(canAdminDocoForRequest(humanRequest(), meta, "user_owner")).resolves.toBe(true);
  });
});

describe("canWriteDocoTypeForRequest enforces the Señor Doco ceiling", () => {
  const meta = { ownerId: "workspace_A", docoId: "doco_1" };

  beforeEach(() => {
    mocks.getDocoUserGrant.mockResolvedValue({ role: "owner", writeTypes: [] });
  });

  it("denies owner-only types (policy) to Señor Doco", async () => {
    await expect(
      canWriteDocoTypeForRequest(senorDocoRequest(), meta, "user_owner", "policy"),
    ).resolves.toBe(false);
  });

  it("still allows owner-only types for a human owner", async () => {
    await expect(
      canWriteDocoTypeForRequest(humanRequest(), meta, "user_owner", "policy"),
    ).resolves.toBe(true);
  });

  it("still allows writable content types (decision) for Señor Doco", async () => {
    await expect(
      canWriteDocoTypeForRequest(senorDocoRequest(), meta, "user_owner", "decision"),
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

describe("listAccessibleDocoIdsInWorkspace (Slack team→workspace binding)", () => {
  it("fails closed: empty workspace id returns [] and runs no query", async () => {
    mocks.query.mockClear();
    await expect(listAccessibleDocoIdsInWorkspace("user_a", "")).resolves.toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("narrows the principal's accessible Docos to the given workspace", async () => {
    mocks.listDocoIdsForUser.mockResolvedValue(["doco_b"]);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("owner_id = $1")) return { rows: [{ id: "doco_a" }] };
      if (sql.includes("owner_id IN")) return { rows: [] };
      // The workspace filter keeps only doco_a (doco_b is in another workspace).
      if (sql.includes("workspace_id = $2")) return { rows: [{ id: "doco_a" }] };
      return { rows: [] };
    });
    await expect(listAccessibleDocoIdsInWorkspace("user_a", "workspace_x")).resolves.toEqual([
      "doco_a",
    ]);
  });

  it("returns [] when the principal can reach nothing", async () => {
    mocks.listDocoIdsForUser.mockResolvedValue([]);
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(listAccessibleDocoIdsInWorkspace("user_a", "workspace_x")).resolves.toEqual([]);
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
