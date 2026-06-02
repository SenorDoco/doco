import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  getDocoById: vi.fn(),
  getDocoLevelRole: vi.fn(),
  getWorkspaceRole: vi.fn(),
  issueInvite: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getUserById: vi.fn(),
  getDocoById: mocks.getDocoById,
  getWorkspaceRole: mocks.getWorkspaceRole,
  listDocoIdsForUser: vi.fn(),
  listDocoUsers: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  withClient: mocks.withClient,
}));

vi.mock("~/lib/db.server", () => ({
  rootDir: () => "/tmp/doco",
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
}));

vi.mock("~/lib/invite-store.server", () => ({
  InviteStore: {
    forDoco: () => ({ issueInvite: mocks.issueInvite }),
  },
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

import { handleUserInviteAction } from "../users.server";

function formRequest(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("https://doco.test/users", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("handleUserInviteAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "user_alice",
      username: "alice",
    });
    mocks.getDocoById.mockResolvedValue({
      id: "doco_bpms",
      handle: "bpms",
      owner_id: "workspace_torre",
    });
    mocks.issueInvite.mockResolvedValue({
      code: "invite_code",
      expires_at: "2026-06-01T00:00:00Z",
      role: "writer",
    });
  });

  it("allows non-owner users to invite at their own role", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("writer");

    const result = await handleUserInviteAction(
      formRequest({
        intent: "invite",
        level: "doco",
        target_id: "doco_bpms",
        role: "writer",
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      invite_url: "https://doco.test/invite/invite_code",
      role: "writer",
    });
    expect(mocks.issueInvite).toHaveBeenCalledWith("doco_bpms", "user_alice", 3, "writer", {
      level: "doco",
    });
  });

  it("caps user invites to the inviter's role", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("writer");

    const result = await handleUserInviteAction(
      formRequest({
        intent: "invite",
        level: "doco",
        target_id: "doco_bpms",
        role: "owner",
      }),
    );

    expect(result).toEqual({
      error: "Cannot mint a 'owner' invite -- you only hold 'writer' on this target.",
    });
    expect(mocks.issueInvite).not.toHaveBeenCalled();
  });

  it("defaults reader invitations to reader when the inviter only has reader", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("reader");

    const result = await handleUserInviteAction(
      formRequest({
        intent: "invite",
        level: "doco",
        target_id: "doco_bpms",
      }),
    );

    expect(result).toMatchObject({ ok: true, role: "reader" });
    expect(mocks.issueInvite).toHaveBeenCalledWith("doco_bpms", "user_alice", 3, "reader", {
      level: "doco",
    });
  });

  it("mints workspace invites even when the workspace has no doco anchor yet", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("writer");
    mocks.withClient.mockImplementation(async (callback) =>
      callback({
        query: vi.fn().mockResolvedValue({
          rows: [{ id: "workspace_torre", handle: "torre", doco_id: null }],
        }),
      }),
    );

    const result = await handleUserInviteAction(
      formRequest({
        intent: "invite",
        level: "workspace",
        target_id: "workspace_torre",
        role: "writer",
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      invite_url: "https://doco.test/invite/invite_code",
      doco_url: "https://doco.test/workspaces/torre/",
      level: "workspace",
      role: "writer",
    });
    expect(mocks.issueInvite).toHaveBeenCalledWith(null, "user_alice", 3, "writer", {
      level: "workspace",
      workspace_id: "workspace_torre",
    });
  });
});
