import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspaceRole: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  getDocoById: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getWorkspaceRole: mocks.getWorkspaceRole,
  listWorkspacesForUser: mocks.listWorkspacesForUser,
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
    mocks.getWorkspaceRole.mockResolvedValue("owner");
    mocks.listWorkspacesForUser.mockResolvedValue([{ id: "workspace_torre" }]);
    mocks.getDocoById.mockResolvedValue({
      id: "doco_bpms",
      handle: "torre-bpms",
      owner_id: "workspace_torre",
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
          level: "workspace",
          targetId: "workspace_torre",
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
      granted_workspace_ids: ["workspace_torre"],
      granted_workspace_roles: { workspace_torre: "writer" },
      granted_workspace_write_types: { workspace_torre: ["*"] },
    });
  });

  it("expands account grants to the approver's owned workspaces", async () => {
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

    expect(grants.granted_workspace_ids).toEqual(["workspace_torre"]);
    expect(grants.granted_workspace_roles).toEqual({ workspace_torre: "reader" });
    expect(grants.granted_workspace_write_types).toEqual({ workspace_torre: ["intent"] });
  });

  // The connector grant: "scope to my full live reach, defer the role to the
  // matrix". Roles are left empty (so effective access = the live matrix role,
  // making read->write a grant change with no re-auth) and write types open
  // (["*"]) so writes defer to the matrix too. Unlike the granular picker it
  // does NOT gate on ownership — a member self-scoping their own connector is
  // safe because effective access stays min(matrix, scope).
  it('identity grant defers scope + role to the matrix ("*"), even with no current reach', async () => {
    // A brand-new user (no reach) can still mint a "*" token so their agent
    // can request access and have it work live, no re-auth. The matrix
    // (min(matrix, *)) is the sole ceiling at access time.
    mocks.listWorkspacesForUser.mockResolvedValue([]);
    mocks.listAccessibleDocoIdsForPrincipal.mockResolvedValue([]);

    const grants = await readOAuthApprovalGrants(
      formWithGrants([{ level: "identity" }]),
      "user_new",
    );

    expect(grants).toEqual({
      granted_doco_ids: ["*"],
      granted_doco_roles: {},
      granted_doco_write_types: { "*": ["*"] },
      granted_workspace_ids: [],
      granted_workspace_roles: {},
      granted_workspace_write_types: {},
    });
    // No ownership gate and no reach lookup — the matrix gates at access time.
    expect(mocks.getDocoLevelRole).not.toHaveBeenCalled();
  });
});
