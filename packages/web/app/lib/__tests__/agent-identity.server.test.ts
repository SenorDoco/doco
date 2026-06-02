import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
  getOauthTokenForRequest: vi.fn(),
  loadScopeOptions: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getUserById: mocks.getUserById,
}));

vi.mock("~/lib/api-keys.server", () => ({
  loadScopeOptions: mocks.loadScopeOptions,
}));

vi.mock("~/lib/doco-access.server", () => ({
  getOauthTokenForRequest: mocks.getOauthTokenForRequest,
  tokenDefersScope: (t: { granted_doco_ids?: readonly string[] | null }) =>
    (t.granted_doco_ids ?? []).includes("*"),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
  userDisplayName: (row: {
    id: string;
    github_login: string | null;
    data: Record<string, unknown>;
  }) => {
    const named = row.data.name ?? row.data.display_name;
    return typeof named === "string" && named.trim() ? named.trim() : (row.github_login ?? row.id);
  },
}));

vi.mock("~/lib/user-invite", () => ({
  rankOf: (role: string) => (role === "owner" ? 3 : role === "writer" ? 2 : 1),
}));

import { loadAgentIdentity } from "../agent-identity.server";

function accessToken(overrides: Record<string, unknown> = {}) {
  return {
    token: "doco_at_test",
    client_id: "doco_client_test",
    client_name: "Local Codex",
    token_name: null,
    user_id: "user_alice",
    granted_doco_ids: [],
    granted_doco_roles: {},
    granted_doco_write_types: {},
    granted_workspace_ids: [],
    granted_workspace_roles: {},
    granted_workspace_write_types: {},
    scope: null,
    expires_at: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("loadAgentIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadScopeOptions.mockResolvedValue([]);
  });

  it("describes a personal API token by nickname on behalf of the user", async () => {
    mocks.getCurrentPrincipalAsync.mockResolvedValue({
      id: "user_alice",
      username: "alice",
      type: "person",
      isHuman: true,
    });
    mocks.getOauthTokenForRequest.mockResolvedValue(
      accessToken({ client_name: "Nightly Doco Runner" }),
    );

    const identity = await loadAgentIdentity(new Request("https://doco.test/api/v1/whoami.json"));

    expect(identity?.credential).toEqual({
      nickname: "Nightly Doco Runner",
      on_behalf_of_username: "alice",
      indicator_prefix: "[🔮 Doco Nightly Doco Runner on behalf of @alice]",
    });
    expect(identity?.indicator_prefix).toBe("[🔮 Doco Nightly Doco Runner on behalf of @alice]");
  });

  it("describes an OAuth token by token name on behalf of the approving user", async () => {
    mocks.getCurrentPrincipalAsync.mockResolvedValue({
      id: "user_owner",
      username: "torrenegra",
      type: "person",
      isHuman: true,
    });
    mocks.getOauthTokenForRequest.mockResolvedValue(
      accessToken({
        client_name: "Doco MCP Server",
        token_name: "Repo Codex",
        user_id: "user_owner",
      }),
    );

    const identity = await loadAgentIdentity(new Request("https://doco.test/api/v1/whoami.json"));

    expect(identity?.credential).toEqual({
      nickname: "Repo Codex",
      on_behalf_of_username: "torrenegra",
      indicator_prefix: "[🔮 Doco Repo Codex on behalf of @torrenegra]",
    });
  });

  it('expands a defer-to-matrix ("*") token to the full reachable set', async () => {
    mocks.getCurrentPrincipalAsync.mockResolvedValue({
      id: "user_alice",
      username: "alice",
      type: "person",
      isHuman: true,
    });
    mocks.loadScopeOptions.mockResolvedValue([
      { level: "workspace", id: "workspace_acme", label: "acme", myRole: "owner" },
      { level: "doco", id: "doco_1", label: "acme/proj1", myRole: "writer" },
    ]);
    // The connector identity token reaches everything the principal can, live —
    // its granted_doco_ids is ["*"], not an explicit id list. Discovery must
    // show the full reachable set, not an empty list.
    mocks.getOauthTokenForRequest.mockResolvedValue(accessToken({ granted_doco_ids: ["*"] }));

    const identity = await loadAgentIdentity(new Request("https://doco.test/api/v1/whoami.json"));

    expect(identity?.grants).toEqual([
      { scope: "workspace", id: "workspace_acme", label: "acme", role: "owner" },
      { scope: "doco", id: "doco_1", label: "acme/proj1", role: "writer" },
    ]);
  });

  it("filters grants to the token's explicitly granted ids and caps the role", async () => {
    mocks.getCurrentPrincipalAsync.mockResolvedValue({
      id: "user_alice",
      username: "alice",
      type: "person",
      isHuman: true,
    });
    mocks.loadScopeOptions.mockResolvedValue([
      { level: "doco", id: "doco_1", label: "acme/proj1", myRole: "owner" },
      { level: "doco", id: "doco_2", label: "acme/proj2", myRole: "owner" },
    ]);
    mocks.getOauthTokenForRequest.mockResolvedValue(
      accessToken({ granted_doco_ids: ["doco_1"], granted_doco_roles: { doco_1: "reader" } }),
    );

    const identity = await loadAgentIdentity(new Request("https://doco.test/api/v1/whoami.json"));

    expect(identity?.grants).toEqual([
      { scope: "doco", id: "doco_1", label: "acme/proj1", role: "reader" },
    ]);
  });
});
