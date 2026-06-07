import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  getDocoById: vi.fn(),
  getDocoLevelRole: vi.fn(),
  getWorkspaceRole: vi.fn(),
  removeDocoUser: vi.fn(),
  removeWorkspaceUser: vi.fn(),
  upsertDocoUser: vi.fn(),
  upsertWorkspaceUser: vi.fn(),
  handleUserInviteAction: vi.fn(),
  loadUsersPageData: vi.fn(),
  renameAgentCollaborator: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getDocoById: mocks.getDocoById,
  getWorkspaceRole: mocks.getWorkspaceRole,
  removeDocoUser: mocks.removeDocoUser,
  removeWorkspaceUser: mocks.removeWorkspaceUser,
  upsertDocoUser: mocks.upsertDocoUser,
  upsertWorkspaceUser: mocks.upsertWorkspaceUser,
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/users.server", () => ({
  handleUserInviteAction: mocks.handleUserInviteAction,
  loadUsersPageData: mocks.loadUsersPageData,
  renameAgentCollaborator: mocks.renameAgentCollaborator,
}));

import { action } from "../users";

function formRequest(fields: Record<string, string>): Request {
  return new Request("https://doco.test/users", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("/users add-grants action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_owner", username: "owner" });
    mocks.getDocoById.mockResolvedValue({
      id: "doco_bpms",
      owner_id: "workspace_torre",
    });
    mocks.getDocoLevelRole.mockResolvedValue("owner");
    mocks.getWorkspaceRole.mockResolvedValue("owner");
  });

  it("adds multiple grants to an existing user", async () => {
    const grants = [
      { level: "workspace", targetId: "workspace_torre", role: "writer", writeTypes: ["*"] },
      { level: "doco", targetId: "doco_bpms", role: "reader", writeTypes: ["decision"] },
    ];

    const result = await action({
      request: formRequest({
        intent: "add_grants",
        user_id: "user_bob",
        grants: JSON.stringify(grants),
      }),
    });

    expect(result).toEqual({
      intent: "add_grants",
      ok: true,
      user_id: "user_bob",
      grants_count: 2,
    });
    expect(mocks.upsertWorkspaceUser).toHaveBeenCalledWith({
      workspace_id: "workspace_torre",
      user_id: "user_bob",
      role: "writer",
      write_types: ["*"],
    });
    expect(mocks.upsertDocoUser).toHaveBeenCalledWith({
      doco_id: "doco_bpms",
      user_id: "user_bob",
      role: "reader",
      write_types: ["decision"],
    });
  });
});
