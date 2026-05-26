import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  getDocoById: vi.fn(),
  getDocoLevelRole: vi.fn(),
  getOrgRole: vi.fn(),
  issueInvite: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getCollaboratorById: vi.fn(),
  getDocoById: mocks.getDocoById,
  getOrgRole: mocks.getOrgRole,
  listDocoIdsForCollaborator: vi.fn(),
  listDocoUsers: vi.fn(),
  listOrganizationsForCollaborator: vi.fn(),
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

import { handleCollaboratorInviteAction } from "../collaborators.server";

function formRequest(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("https://doco.test/collaborators", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("handleCollaboratorInviteAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "collaborator_alice",
      username: "alice",
    });
    mocks.getDocoById.mockResolvedValue({
      id: "doco_bpms",
      handle: "bpms",
      owner_id: "organization_torre",
    });
    mocks.issueInvite.mockResolvedValue({
      code: "invite_code",
      expires_at: "2026-06-01T00:00:00Z",
      role: "author",
    });
  });

  it("allows non-owner collaborators to invite at their own role", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("author");

    const result = await handleCollaboratorInviteAction(
      formRequest({
        intent: "invite",
        level: "doco",
        target_id: "doco_bpms",
        role: "author",
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      invite_url: "https://doco.test/invite/invite_code",
      role: "author",
    });
    expect(mocks.issueInvite).toHaveBeenCalledWith("doco_bpms", "collaborator_alice", 3, "author", {
      level: "doco",
    });
  });

  it("caps collaborator invites to the inviter's role", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("author");

    const result = await handleCollaboratorInviteAction(
      formRequest({
        intent: "invite",
        level: "doco",
        target_id: "doco_bpms",
        role: "approver",
      }),
    );

    expect(result).toEqual({
      error: "Cannot mint a 'approver' invite -- you only hold 'author' on this target.",
    });
    expect(mocks.issueInvite).not.toHaveBeenCalled();
  });

  it("defaults reader invitations to reader when the inviter only has reader", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("reader");

    const result = await handleCollaboratorInviteAction(
      formRequest({
        intent: "invite",
        level: "doco",
        target_id: "doco_bpms",
      }),
    );

    expect(result).toMatchObject({ ok: true, role: "reader" });
    expect(mocks.issueInvite).toHaveBeenCalledWith("doco_bpms", "collaborator_alice", 3, "reader", {
      level: "doco",
    });
  });
});
