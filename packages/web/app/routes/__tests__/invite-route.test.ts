import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeInvite: vi.fn(),
  findInvite: vi.fn(),
  getCollaboratorById: vi.fn(),
  getCurrentPrincipal: vi.fn(),
  getDocoById: vi.fn(),
  query: vi.fn(),
  upsertDocoUser: vi.fn(),
  upsertOrgUser: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getCollaboratorById: mocks.getCollaboratorById,
  getDocoById: mocks.getDocoById,
  upsertDocoUser: mocks.upsertDocoUser,
  upsertOrgUser: mocks.upsertOrgUser,
  withClient: mocks.withClient,
}));

vi.mock("~/lib/db.server", () => ({
  rootDir: () => "/tmp/doco",
}));

vi.mock("~/lib/invite-store.server", () => ({
  InviteStore: {
    forDoco: () => ({
      consumeInvite: mocks.consumeInvite,
      findInvite: mocks.findInvite,
    }),
  },
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

import { action, loader } from "../invite.$code";

const ORG_INVITE = {
  kind: "invite",
  code: "invite_code",
  level: "org",
  org_id: "organization_torre",
  minted_by_collaborator_id: "collaborator_owner",
  role: "author",
  expires_at: "2026-06-01T00:00:00.000Z",
  issued_at: "2026-05-30T00:00:00.000Z",
  status: "pending",
  redeemed_by_collaborator_id: null,
  redeemed_at: null,
};

function request(method = "GET"): Request {
  return new Request("https://doco.test/invite/invite_code", { method });
}

describe("/invite/:code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "collaborator_alice",
      username: "alice",
    });
    mocks.getCollaboratorById.mockResolvedValue({
      id: "collaborator_owner",
      github_login: "owner",
    });
    mocks.findInvite.mockResolvedValue(ORG_INVITE);
    mocks.consumeInvite.mockResolvedValue({
      ...ORG_INVITE,
      status: "consumed",
      redeemed_by_collaborator_id: "collaborator_alice",
      redeemed_at: "2026-05-30T01:00:00.000Z",
    });
    mocks.query.mockResolvedValue({
      rows: [{ id: "organization_torre", handle: "torre" }],
    });
    mocks.withClient.mockImplementation((callback) => callback({ query: mocks.query }));
  });

  it("loads org-only invites without a doco anchor", async () => {
    const result = await loader({
      request: request(),
      params: { code: "invite_code" },
    });

    expect(result).toMatchObject({
      ok: true,
      target: { level: "org", label: "torre" },
      inviter: { username: "owner" },
      signedIn: { username: "alice" },
    });
    expect(mocks.getDocoById).not.toHaveBeenCalled();
  });

  it("accepts org-only invites by granting org membership", async () => {
    const result = await action({
      request: request("POST"),
      params: { code: "invite_code" },
    });

    expect(result).toMatchObject({
      ok: true,
      continue_to: "/orgs/torre",
      target_label: "torre",
    });
    expect(mocks.upsertOrgUser).toHaveBeenCalledWith({
      org_id: "organization_torre",
      collaborator_id: "collaborator_alice",
      role: "author",
    });
    expect(mocks.upsertDocoUser).not.toHaveBeenCalled();
  });
});
