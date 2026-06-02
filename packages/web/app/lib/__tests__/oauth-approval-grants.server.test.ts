import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrgRole: vi.fn(),
  listOrganizationsForUser: vi.fn(),
  getDocoById: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getOrgRole: mocks.getOrgRole,
  listOrganizationsForUser: mocks.listOrganizationsForUser,
}));

vi.mock("~/lib/db.server", () => ({
  getDocoById: mocks.getDocoById,
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal: mocks.listAccessibleDocoIdsForPrincipal,
}));

import { readOAuthApprovalGrants } from "../oauth-approval-grants.server";

function formWithGrants(grants: unknown[]): FormData {
  const form = new FormData();
  form.set("grants", JSON.stringify(grants));
  return form;
}

describe("readOAuthApprovalGrants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrgRole.mockResolvedValue("owner");
    mocks.listOrganizationsForUser.mockResolvedValue([{ id: "organization_torre" }]);
    mocks.getDocoById.mockResolvedValue({
      id: "doco_bpms",
      handle: "torre-bpms",
      owner_id: "organization_torre",
    });
    mocks.getDocoLevelRole.mockResolvedValue("owner");
    mocks.listAccessibleDocoIdsForPrincipal.mockResolvedValue(["doco_bpms"]);
  });

  it("serializes shared picker grants into OAuth role and per-type maps", async () => {
    const grants = await readOAuthApprovalGrants(
      formWithGrants([
        {
          level: "doco",
          targetId: "doco_bpms",
          role: "reader",
          writeTypes: ["decision"],
        },
        {
          level: "org",
          targetId: "organization_torre",
          role: "writer",
          writeTypes: ["*"],
        },
      ]),
      "user_owner",
    );

    expect(grants).toEqual({
      granted_doco_ids: ["doco_bpms"],
      granted_doco_roles: { doco_bpms: "reader" },
      granted_doco_write_types: { doco_bpms: ["decision"] },
      granted_org_ids: ["organization_torre"],
      granted_org_roles: { organization_torre: "writer" },
      granted_org_write_types: { organization_torre: ["*"] },
    });
  });

  it("expands account grants to the approver's owned organizations", async () => {
    const grants = await readOAuthApprovalGrants(
      formWithGrants([
        {
          level: "account",
          targetId: "",
          role: "reader",
          writeTypes: ["intent"],
        },
      ]),
      "user_owner",
    );

    expect(grants.granted_org_ids).toEqual(["organization_torre"]);
    expect(grants.granted_org_roles).toEqual({ organization_torre: "reader" });
    expect(grants.granted_org_write_types).toEqual({ organization_torre: ["intent"] });
  });

  // The connector grant: "scope to my full live reach, defer the role to the
  // matrix". Roles are left empty (so effective access = the live matrix role,
  // making read->write a grant change with no re-auth) and write types open
  // (["*"]) so writes defer to the matrix too. Unlike the granular picker it
  // does NOT gate on ownership — a member self-scoping their own connector is
  // safe because effective access stays min(matrix, scope).
  it("identity grant scopes to the principal's full reach, roles deferred to the matrix", async () => {
    mocks.listOrganizationsForUser.mockResolvedValue([
      { id: "organization_torre" },
      { id: "organization_acme" },
    ]);
    mocks.listAccessibleDocoIdsForPrincipal.mockResolvedValue(["doco_bpms", "doco_road"]);

    const grants = await readOAuthApprovalGrants(
      formWithGrants([{ level: "identity" }]),
      "user_member",
    );

    expect(grants).toEqual({
      granted_doco_ids: ["doco_bpms", "doco_road"],
      granted_doco_roles: {},
      granted_doco_write_types: { doco_bpms: ["*"], doco_road: ["*"] },
      granted_org_ids: ["organization_acme", "organization_torre"],
      granted_org_roles: {},
      granted_org_write_types: { organization_acme: ["*"], organization_torre: ["*"] },
    });
    // No ownership gate — the granular path keeps its owner check, this one
    // relies on min(matrix, scope) instead.
    expect(mocks.getDocoLevelRole).not.toHaveBeenCalled();
  });

  it("identity grant errors when the principal can reach nothing", async () => {
    mocks.listOrganizationsForUser.mockResolvedValue([]);
    mocks.listAccessibleDocoIdsForPrincipal.mockResolvedValue([]);

    await expect(
      readOAuthApprovalGrants(formWithGrants([{ level: "identity" }]), "user_new"),
    ).rejects.toMatchObject({ status: 400 });
  });
});
