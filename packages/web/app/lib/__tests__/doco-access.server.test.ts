import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidAccessToken } from "../oauth-server.server";

const mocks = vi.hoisted(() => ({
  getAccountGrant: vi.fn(),
  getDocoUserGrant: vi.fn(),
  getOrgGrant: vi.fn(),
  getPrincipalById: vi.fn(),
  listOrgOwnerUserIds: vi.fn(),
  validateAccessToken: vi.fn(),
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
    listDocoIdsForUser: vi.fn(),
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
    withClient: vi.fn(),
  };
});

vi.mock("../oauth-server.server", () => ({
  validateAccessToken: mocks.validateAccessToken,
}));

import { canWriteDocoTypeForRequest, oauthTokenGrantsDoco } from "../doco-access.server";

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
