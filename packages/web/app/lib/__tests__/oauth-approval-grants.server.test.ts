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

  // The full-access ("identity") grant was removed: a token is capped at a
  // single workspace. A payload still carrying the legacy level is treated as
  // an unknown grant with no target, which is rejected.
  it("rejects a legacy identity grant payload (no full-access tokens)", async () => {
    await expect(
      readOAuthApprovalGrants(formWithGrants([{ level: "identity" }]), "user_new"),
    ).rejects.toBeInstanceOf(Response);
  });
});
