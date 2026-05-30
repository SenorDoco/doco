import { describe, expect, it } from "vitest";
import { oauthTokenGrantsDoco } from "../doco-access.server";
import type { ValidAccessToken } from "../oauth-server.server";

function token(overrides: Partial<ValidAccessToken>): ValidAccessToken {
  return {
    token: "doco_at_x",
    client_id: "doco_client_x",
    user_id: "principal_X",
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
