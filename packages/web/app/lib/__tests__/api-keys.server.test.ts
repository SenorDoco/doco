import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withClient: vi.fn(),
  getOrgRole: vi.fn(),
  listOrganizationsForUser: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
  issueTokens: vi.fn(),
  registerClient: vi.fn(),
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
  issueTokens: mocks.issueTokens,
  registerClient: mocks.registerClient,
}));

import { addGrantsToApiKey, listApiKeysForUser } from "../api-keys.server";

describe("listApiKeysForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("labels OAuth tokens with the stored token name", async () => {
    mocks.withClient.mockImplementation(async (callback) =>
      callback({
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              client_id: "doco_client_agent",
              client_name: "Claude Code",
              token_name: "Repo Codex",
              user_id: "user_owner",
              user_kind: "person",
              user_login: "torrenegra",
              user_data: {},
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
        source: "oauth",
      }),
    ]);
  });
});

describe("addGrantsToApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDocoLevelRole.mockResolvedValue("owner");
    mocks.getOrgRole.mockResolvedValue("owner");
  });

  it("preserves untouched grants while replacing the target being modified", async () => {
    const queries = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("SELECT owner_id FROM docos")) {
        return { rows: [{ owner_id: "organization_torre" }] };
      }
      if (sql.includes("FROM oauth_refresh_tokens")) {
        return {
          rows: [
            {
              client_id: "doco_client_existing",
              user_id: "user_agent",
              granted_doco_ids: ["doco_existing", "doco_untouched"],
              granted_doco_roles: { doco_existing: "reader", doco_untouched: "reader" },
              granted_doco_write_types: {
                doco_existing: ["decision"],
                doco_untouched: ["rule"],
              },
              granted_org_ids: [],
              granted_org_roles: {},
              granted_org_write_types: {},
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    mocks.withClient.mockImplementation(async (callback) => callback({ query: queries }));

    await addGrantsToApiKey({
      me: { id: "user_owner", username: "owner" } as never,
      client_id: "doco_client_existing",
      grants: [
        {
          level: "doco",
          target_id: "doco_existing",
          role: "reader",
          write_types: ["intent"],
        },
        {
          level: "doco",
          target_id: "doco_new",
          role: "writer",
          write_types: ["*"],
        },
      ],
    });

    const refreshUpdate = queries.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE oauth_refresh_tokens"),
    );
    const accessUpdate = queries.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE oauth_access_tokens"),
    );
    expect(refreshUpdate).toBeTruthy();
    expect(accessUpdate).toBeTruthy();

    const values = (refreshUpdate?.[1] ?? []) as unknown[];
    expect(values[1]).toEqual(["doco_existing", "doco_new", "doco_untouched"]);
    expect(JSON.parse(String(values[2]))).toEqual({
      doco_existing: "reader",
      doco_new: "writer",
      doco_untouched: "reader",
    });
    expect(JSON.parse(String(values[3]))).toEqual({
      doco_existing: ["intent"],
      doco_new: ["*"],
      doco_untouched: ["rule"],
    });
  });
});
