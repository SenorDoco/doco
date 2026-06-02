import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidAccessToken } from "../oauth-server.server";

const mocks = vi.hoisted(() => ({
  getAccountGrant: vi.fn(),
  getDocoUserGrant: vi.fn(),
  getOrgGrant: vi.fn(),
  getPrincipalById: vi.fn(),
  listDocoIdsForUser: vi.fn(),
  listOrgOwnerUserIds: vi.fn(),
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
    getOrgGrant: mocks.getOrgGrant,
    getOrgRole: vi.fn(),
    getPrincipalById: mocks.getPrincipalById,
    isOrgUser: vi.fn(),
    listDocoIdsForUser: mocks.listDocoIdsForUser,
    listOrgOwnerUserIds: mocks.listOrgOwnerUserIds,
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
  filterDocosToOrgBoundary,
  listVisibleDocoIdsForRequest,
  oauthTokenGrantsDoco,
  tokenReachableOrgIdsForRequest,
  tokenReachableOrgIdsFromGrant,
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
    granted_org_ids: [],
    granted_org_roles: {},
    granted_org_write_types: {},
    scope: null,
    expires_at: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAccountGrant.mockResolvedValue(null);
  mocks.getDocoUserGrant.mockResolvedValue(null);
  mocks.getOrgGrant.mockResolvedValue(null);
  mocks.getPrincipalById.mockResolvedValue(null);
  mocks.listOrgOwnerUserIds.mockResolvedValue([]);
  mocks.validateAccessToken.mockResolvedValue(null);
  mocks.listDocoIdsForUser.mockResolvedValue([]);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.withClient.mockImplementation(async (fn: (c: { query: typeof mocks.query }) => unknown) =>
    fn({ query: mocks.query }),
  );
});

describe("oauthTokenGrantsDoco", () => {
  const orgOwned = { ownerId: "organization_A", docoId: "doco_1" };
  const principalOwned = { ownerId: "principal_USER", docoId: "doco_2" };

  it("matches when the Doco id is in granted_doco_ids", () => {
    const t = token({ granted_doco_ids: ["doco_1"] });
    expect(oauthTokenGrantsDoco(t, orgOwned)).toBe(true);
  });

  it("matches when an org-owned Doco's owner is in granted_org_ids", () => {
    const t = token({ granted_org_ids: ["organization_A"] });
    expect(oauthTokenGrantsDoco(t, orgOwned)).toBe(true);
  });

  it("rejects when neither the Doco nor its owner org is granted", () => {
    const t = token({
      granted_doco_ids: ["doco_other"],
      granted_org_ids: ["organization_other"],
    });
    expect(oauthTokenGrantsDoco(t, orgOwned)).toBe(false);
  });

  it("does not let a personal-Principal-owned Doco match an org grant", () => {
    // The leak this regression-guards: an org grant must not extend
    // to Docos owned directly by a Principal (even one who happens to
    // belong to the granted org).
    const t = token({ granted_org_ids: ["organization_A"] });
    expect(oauthTokenGrantsDoco(t, principalOwned)).toBe(false);
  });

  it("rejects when both grant lists are empty", () => {
    const t = token({});
    expect(oauthTokenGrantsDoco(t, orgOwned)).toBe(false);
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
        { ownerId: "organization_A", docoId: "doco_1" },
        "user_agent",
        "principal",
      ),
    ).resolves.toBe(true);
  });
});

describe("tokenReachableOrgIdsFromGrant", () => {
  it("unions granted org ids with the orgs that own granted Docos", () => {
    const t = token({
      granted_org_ids: ["organization_meta"],
      granted_doco_ids: ["doco_torre1"],
    });
    const owners = new Map([["doco_torre1", "organization_torre"]]);
    expect([...tokenReachableOrgIdsFromGrant(t, owners)].sort()).toEqual([
      "organization_meta",
      "organization_torre",
    ]);
  });

  it("ignores granted Docos owned by a principal (no org to reach)", () => {
    const t = token({ granted_doco_ids: ["doco_personal"] });
    const owners = new Map([["doco_personal", "principal_alice"]]);
    expect([...tokenReachableOrgIdsFromGrant(t, owners)]).toEqual([]);
  });
});

describe("filterDocosToOrgBoundary", () => {
  // Alice belongs to two orgs and owns a personal Doco.
  const owners = new Map<string, string>([
    ["doco_torre1", "organization_torre"],
    ["doco_torre2", "organization_torre"],
    ["doco_meta1", "organization_meta"],
    ["doco_personal", "principal_alice"],
  ]);
  const accessible = ["doco_torre1", "doco_torre2", "doco_meta1", "doco_personal"];

  it("a Doco-scoped token sees same-org siblings but not other orgs", () => {
    // The screenshot bug: a token scoped to one Doco in org torre must
    // not surface meta-doco's Docos, even though the human is in both.
    const t = token({ granted_doco_ids: ["doco_torre1"] });
    expect(filterDocosToOrgBoundary(accessible, owners, t)).toEqual(["doco_torre1", "doco_torre2"]);
  });

  it("an org-scoped token sees only that org's Docos", () => {
    const t = token({ granted_org_ids: ["organization_meta"] });
    expect(filterDocosToOrgBoundary(accessible, owners, t)).toEqual(["doco_meta1"]);
  });

  it("a Doco individually granted in another org is still listed", () => {
    const t = token({ granted_doco_ids: ["doco_torre1", "doco_meta1"] });
    expect(filterDocosToOrgBoundary(accessible, owners, t)).toEqual([
      "doco_torre1",
      "doco_torre2",
      "doco_meta1",
    ]);
  });

  it("an org grant never surfaces a personal (principal-owned) Doco", () => {
    const t = token({ granted_org_ids: ["organization_torre"] });
    expect(filterDocosToOrgBoundary(accessible, owners, t)).toEqual(["doco_torre1", "doco_torre2"]);
  });

  it("a token granting nothing sees nothing", () => {
    const t = token({});
    expect(filterDocosToOrgBoundary(accessible, owners, t)).toEqual([]);
  });
});

describe("listVisibleDocoIdsForRequest", () => {
  // The principal (Alice) belongs to two orgs; org membership surfaces
  // one Doco from each via `listAccessibleDocoIdsForPrincipal`.
  function dbReturns(viaOrgDocoIds: string[], ownerRows: { id: string; owner_id: string }[]) {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("org_users")) return { rows: viaOrgDocoIds.map((id) => ({ id })) };
      if (sql.includes("id, owner_id FROM docos")) return { rows: ownerRows };
      return { rows: [] }; // direct-ownership query
    });
  }

  it("narrows an OAuth token to its org boundary (the cross-org leak fix)", async () => {
    dbReturns(
      ["doco_torre1", "doco_meta1"],
      [
        { id: "doco_torre1", owner_id: "organization_torre" },
        { id: "doco_meta1", owner_id: "organization_meta" },
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
        { id: "doco_torre1", owner_id: "organization_torre" },
        { id: "doco_meta1", owner_id: "organization_meta" },
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

describe("tokenReachableOrgIdsForRequest", () => {
  it("returns null without a bearer (no token scope-down to apply)", async () => {
    const request = new Request("https://doco.test/api/v1/orgs.json");
    await expect(tokenReachableOrgIdsForRequest(request)).resolves.toBeNull();
  });

  it("unions granted-doco orgs with granted org ids", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("id, owner_id FROM docos")) {
        return { rows: [{ id: "doco_torre1", owner_id: "organization_torre" }] };
      }
      return { rows: [] };
    });
    mocks.validateAccessToken.mockResolvedValue(
      token({ granted_org_ids: ["organization_meta"], granted_doco_ids: ["doco_torre1"] }),
    );
    const request = new Request("https://doco.test/api/v1/orgs.json", {
      headers: { Authorization: "Bearer doco_at_x" },
    });
    const reachable = await tokenReachableOrgIdsForRequest(request);
    expect(reachable && [...reachable].sort()).toEqual(["organization_meta", "organization_torre"]);
  });
});

describe('defer-scope ("*") connector token', () => {
  it("grants any Doco at the scope gate (the matrix gates the role/write elsewhere)", () => {
    const t = token({ granted_doco_ids: ["*"] });
    expect(oauthTokenGrantsDoco(t, { ownerId: "organization_A", docoId: "doco_anything" })).toBe(
      true,
    );
    expect(oauthTokenGrantsDoco(t, { ownerId: "principal_USER", docoId: "doco_personal" })).toBe(
      true,
    );
  });

  it("enumerates every accessible Doco (no org-boundary narrowing)", () => {
    const owners = new Map([
      ["doco_torre1", "organization_torre"],
      ["doco_meta1", "organization_meta"],
      ["doco_personal", "principal_alice"],
    ]);
    const accessible = ["doco_torre1", "doco_meta1", "doco_personal"];
    expect(
      filterDocosToOrgBoundary(accessible, owners, token({ granted_doco_ids: ["*"] })),
    ).toEqual(accessible);
  });

  it("applies no org narrowing for listings (returns null)", async () => {
    mocks.validateAccessToken.mockResolvedValue(token({ granted_doco_ids: ["*"] }));
    const request = new Request("https://doco.test/api/v1/orgs.json", {
      headers: { Authorization: "Bearer doco_at_x" },
    });
    await expect(tokenReachableOrgIdsForRequest(request)).resolves.toBeNull();
  });

  it("ALLOWS a write when the live matrix grants it", async () => {
    mocks.getDocoUserGrant.mockResolvedValue({ role: "writer", writeTypes: ["*"] });
    mocks.validateAccessToken.mockResolvedValue(
      token({ granted_doco_ids: ["*"], granted_doco_write_types: { "*": ["*"] } }),
    );
    const request = new Request("https://doco.test/acme/api/decisions.json", {
      headers: { Authorization: "Bearer doco_at_x" },
    });
    await expect(
      canWriteDocoTypeForRequest(
        request,
        { ownerId: "organization_A", docoId: "doco_new" },
        "user_agent",
        "decision",
      ),
    ).resolves.toBe(true);
  });

  it("DENIES a write when the principal has NO matrix grant (no over-grant)", async () => {
    // The safety invariant: "*" defers to the matrix; it can never exceed it.
    mocks.getDocoUserGrant.mockResolvedValue(null);
    mocks.validateAccessToken.mockResolvedValue(
      token({ granted_doco_ids: ["*"], granted_doco_write_types: { "*": ["*"] } }),
    );
    const request = new Request("https://doco.test/acme/api/decisions.json", {
      headers: { Authorization: "Bearer doco_at_x" },
    });
    await expect(
      canWriteDocoTypeForRequest(
        request,
        { ownerId: "organization_A", docoId: "doco_new" },
        "user_agent",
        "decision",
      ),
    ).resolves.toBe(false);
  });
});
