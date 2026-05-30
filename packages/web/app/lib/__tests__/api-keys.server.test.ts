import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withClient: vi.fn(),
  getOrgRole: vi.fn(),
  listOrganizationsForUser: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: mocks.withClient,
  getOrgRole: mocks.getOrgRole,
  listOrganizationsForUser: mocks.listOrganizationsForUser,
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal: mocks.listAccessibleDocoIdsForPrincipal,
}));

vi.mock("~/lib/user-invite", () => ({
  ALL_ROLES: ["reader", "writer", "owner"],
  rankOf: (role: string) =>
    role === "owner" ? 3 : role === "writer" ? 2 : role === "writer" ? 1 : 0,
}));

vi.mock("~/lib/doco-labels", () => ({
  qualifiedDocoLabel: ({ ownerSlug, handle }: { ownerSlug: string; handle: string }) =>
    ownerSlug ? `${ownerSlug}/${handle}` : handle,
}));

vi.mock("~/lib/oauth-server.server", () => ({
  issueTokens: vi.fn(),
  registerClient: vi.fn(),
}));

import { listApiKeysForUser } from "../api-keys.server";

describe("listApiKeysForUser", () => {
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
              user_id: "user_agent",
              user_kind: "agent",
              user_login: null,
              user_data: { name: "Repo Codex" },
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

    const keys = await listApiKeysForUser("user_owner");

    expect(keys).toEqual([
      expect.objectContaining({
        client_id: "doco_client_agent",
        client_name: "Repo Codex",
        source: "agent",
      }),
    ]);
  });
});
