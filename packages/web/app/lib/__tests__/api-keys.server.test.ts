import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withClient: vi.fn(),
  getOrgRole: vi.fn(),
  listOrganizationsForCollaborator: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: mocks.withClient,
  getOrgRole: mocks.getOrgRole,
  listOrganizationsForCollaborator: mocks.listOrganizationsForCollaborator,
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal: mocks.listAccessibleDocoIdsForPrincipal,
}));

vi.mock("~/lib/collaborator-invite", () => ({
  ALL_ROLES: ["reader", "author", "approver", "owner"],
  rankOf: (role: string) =>
    role === "owner" ? 3 : role === "approver" ? 2 : role === "author" ? 1 : 0,
}));

vi.mock("~/lib/doco-labels", () => ({
  qualifiedDocoLabel: ({ ownerSlug, handle }: { ownerSlug: string; handle: string }) =>
    ownerSlug ? `${ownerSlug}/${handle}` : handle,
}));

vi.mock("~/lib/oauth-server.server", () => ({
  issueTokens: vi.fn(),
  registerClient: vi.fn(),
}));

import { listApiKeysForCollaborator } from "../api-keys.server";

describe("listApiKeysForCollaborator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("labels owned-agent OAuth keys with the user-provided agent name", async () => {
    mocks.withClient.mockImplementation(async (callback) =>
      callback({
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              client_id: "doco_client_agent",
              client_name: "Claude Code",
              collaborator_id: "collaborator_agent",
              collaborator_kind: "agent",
              collaborator_login: null,
              collaborator_data: { name: "Repo Codex" },
              redirect_uris: ["http://127.0.0.1:4321/callback"],
              granted_doco_ids: [],
              granted_doco_roles: {},
              granted_org_ids: [],
              granted_org_roles: {},
              created_at: new Date("2026-05-27T12:00:00Z"),
              expires_at: new Date("2026-07-27T12:00:00Z"),
              last_seen_at: null,
            },
          ],
        }),
      }),
    );

    const keys = await listApiKeysForCollaborator("collaborator_owner");

    expect(keys).toEqual([
      expect.objectContaining({
        client_id: "doco_client_agent",
        client_name: "Repo Codex",
        source: "agent",
      }),
    ]);
  });
});
