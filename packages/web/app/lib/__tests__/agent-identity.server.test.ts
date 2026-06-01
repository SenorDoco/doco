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
    granted_org_ids: [],
    granted_org_roles: {},
    granted_org_write_types: {},
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
});
