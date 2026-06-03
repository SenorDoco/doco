import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  getClient: vi.fn(),
  issueAuthorizationCode: vi.fn(),
  readOAuthApprovalGrants: vi.fn(),
  loadApprovalGrantOptions: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: mocks.getCurrentPrincipal }));
vi.mock("~/lib/oauth-server.server", () => ({
  getClient: mocks.getClient,
  issueAuthorizationCode: mocks.issueAuthorizationCode,
}));
vi.mock("~/lib/oauth-approval-grants.server", () => ({
  readOAuthApprovalGrants: mocks.readOAuthApprovalGrants,
  loadApprovalGrantOptions: mocks.loadApprovalGrantOptions,
}));

import { action } from "../oauth.authorize";

// Authorize request bound to workspace_01ABC's MCP (RFC 8707 resource).
const BOUND_URL =
  "https://doco.test/oauth/authorize?response_type=code&client_id=doco_client_x" +
  "&redirect_uri=http%3A%2F%2Flocalhost%3A53682%2Fcallback&code_challenge=abc" +
  "&code_challenge_method=S256&resource=https%3A%2F%2Fdoco.test%2Fworkspace_01ABC%2Fmcp";

function approveRequest(): Request {
  return new Request(BOUND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision: "approve", token_name: "Claude", grants: "[]" }),
  });
}

function workspaceGrants(workspaceId: string) {
  return {
    granted_doco_ids: [],
    granted_doco_roles: {},
    granted_doco_write_types: {},
    granted_workspace_ids: [workspaceId],
    granted_workspace_roles: { [workspaceId]: "writer" },
    granted_workspace_write_types: {},
  };
}

describe("/oauth/authorize action — bound-workspace guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice" });
    mocks.getClient.mockResolvedValue({
      client_id: "doco_client_x",
      client_name: "Claude",
      redirect_uris: ["http://localhost:53682/callback"],
    });
    mocks.issueAuthorizationCode.mockResolvedValue({ code: "authcode_1" });
  });

  it("issues a code when the approved grant is the connector's own workspace", async () => {
    mocks.readOAuthApprovalGrants.mockResolvedValue(workspaceGrants("workspace_01ABC"));

    const res = await action({ request: approveRequest() });

    expect(mocks.issueAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302); // → /oauth/approved
  });

  it("rejects a grant for a different workspace than the connector's resource", async () => {
    mocks.readOAuthApprovalGrants.mockResolvedValue(workspaceGrants("workspace_OTHER"));

    await expect(action({ request: approveRequest() })).rejects.toMatchObject({ status: 400 });
    expect(mocks.issueAuthorizationCode).not.toHaveBeenCalled();
  });
});
