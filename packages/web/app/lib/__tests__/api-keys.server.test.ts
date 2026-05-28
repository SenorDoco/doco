import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: mocks.withClient,
  getOrgRole: vi.fn(),
  listOrganizationsForCollaborator: vi.fn(),
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
}));

vi.mock("~/lib/oauth-server.server", () => ({
  issueTokens: vi.fn(),
  registerClient: vi.fn(),
}));

vi.mock("~/lib/collaborator-invite", () => ({
  ALL_ROLES: ["reader", "author", "approver", "owner"],
  rankOf: vi.fn(),
}));

import { listApiKeysForCollaborator } from "../api-keys.server";

interface MainRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  granted_doco_ids: string[] | null;
  granted_doco_roles: Record<string, string> | null;
  granted_org_ids: string[] | null;
  granted_org_roles: Record<string, string> | null;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
}

function row(over: Partial<MainRow> & { client_id: string }): MainRow {
  return {
    client_name: over.client_id,
    redirect_uris: [],
    granted_doco_ids: [],
    granted_doco_roles: {},
    granted_org_ids: [],
    granted_org_roles: {},
    created_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-12-01T00:00:00Z",
    last_seen_at: null,
    ...over,
  };
}

describe("listApiKeysForCollaborator ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withClient.mockImplementation((fn) => fn({ query: mocks.query }));
  });

  it("orders most-recently-used first and never-used keys last", async () => {
    // Returned by the DB in an arbitrary (client_id) order; the function
    // is responsible for re-sorting by recency of use.
    mocks.query.mockResolvedValue({
      rows: [
        row({
          client_id: "c_b",
          created_at: "2026-05-20T00:00:00Z",
          last_seen_at: "2026-05-21T00:00:00Z",
        }),
        row({
          client_id: "c_a",
          created_at: "2026-05-01T00:00:00Z",
          last_seen_at: "2026-05-25T00:00:00Z",
        }),
        row({ client_id: "c_d", created_at: "2026-05-15T00:00:00Z", last_seen_at: null }),
        row({ client_id: "c_c", created_at: "2026-05-10T00:00:00Z", last_seen_at: null }),
      ],
    });

    const keys = await listApiKeysForCollaborator("collaborator_1");

    // c_a (used 05-25) > c_b (used 05-21) > never-used, by most recent
    // grant: c_d (05-15) > c_c (05-10). Note c_a sorts above c_b despite
    // being granted earlier — proving the sort is by use, not by grant.
    expect(keys.map((k) => k.client_id)).toEqual(["c_a", "c_b", "c_d", "c_c"]);
  });
});
