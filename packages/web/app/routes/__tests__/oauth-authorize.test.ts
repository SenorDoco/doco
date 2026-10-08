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

// Unbound authorize request — no RFC 8707 resource, so the consent covers the
// whole account (the path that can mint an actor credential).
const UNBOUND_URL =
  "https://doco.test/oauth/authorize?response_type=code&client_id=doco_client_x" +
  "&redirect_uri=http%3A%2F%2Flocalhost%3A53682%2Fcallback&code_challenge=abc" +
  "&code_challenge_method=S256";

function approveRequest(url: string = BOUND_URL): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision: "approve", grants: "[]" }),
  });
}

function actorGrants() {
  return {
    granted_doco_ids: [],
    granted_doco_roles: {},
    granted_doco_write_types: {},
    granted_workspace_ids: [],
    granted_workspace_roles: {},
    granted_workspace_write_types: {},
    grant_type: "actor",
  };
}

function workspaceGrants(workspaceId: string) {
  return {
    granted_doco_ids: [],
    granted_doco_roles: {},
    granted_doco_write_types: {},
    granted_workspace_ids: [workspaceId],
    granted_workspace_roles: { [workspaceId]: "writer" },
    granted_workspace_write_types: {},
    grant_type: "regular",
  };
}

function docoGrants(docoId: string) {
  return {
    granted_doco_ids: [docoId],
    granted_doco_roles: { [docoId]: "writer" },
    granted_doco_write_types: {},
    granted_workspace_ids: [],
    granted_workspace_roles: {},
    granted_workspace_write_types: {},
    grant_type: "regular",
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
    // The approver owns the bound workspace (workspace_01ABC) and one Doco in it.
    mocks.loadApprovalGrantOptions.mockResolvedValue({
      docos: [
        {
          id: "doco_1",
          handle: "d1",
          my_role: "owner",
          workspace_id: "workspace_01ABC",
          workspace_label: "acme",
        },
      ],
      workspaces: [
        { id: "workspace_01ABC", handle: "acme", display_name: "acme", my_role: "owner" },
      ],
    });
  });

  it("issues a code when the approved grant is the connector's own workspace", async () => {
    mocks.readOAuthApprovalGrants.mockResolvedValue(workspaceGrants("workspace_01ABC"));

    const res = await action({ request: approveRequest() });

    expect(mocks.issueAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302); // → /oauth/approved
  });

  it("allows narrowing to a Doco within the connector's workspace", async () => {
    mocks.readOAuthApprovalGrants.mockResolvedValue(docoGrants("doco_1"));

    const res = await action({ request: approveRequest() });

    expect(mocks.issueAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
  });

  it("rejects a grant for a different workspace than the connector's resource", async () => {
    mocks.readOAuthApprovalGrants.mockResolvedValue(workspaceGrants("workspace_OTHER"));

    await expect(action({ request: approveRequest() })).rejects.toMatchObject({ status: 400 });
    expect(mocks.issueAuthorizationCode).not.toHaveBeenCalled();
  });

  it("rejects a Doco that isn't in the connector's workspace", async () => {
    mocks.readOAuthApprovalGrants.mockResolvedValue(docoGrants("doco_OTHER"));

    await expect(action({ request: approveRequest() })).rejects.toMatchObject({ status: 400 });
    expect(mocks.issueAuthorizationCode).not.toHaveBeenCalled();
  });

  // A bound (per-workspace) connector must never mint an actor token — that
  // all-workspaces credential would defeat the connector's workspace binding.
  it("rejects an actor grant from a bound (per-workspace) connector", async () => {
    mocks.readOAuthApprovalGrants.mockResolvedValue(actorGrants());

    await expect(action({ request: approveRequest() })).rejects.toMatchObject({ status: 400 });
    expect(mocks.issueAuthorizationCode).not.toHaveBeenCalled();
  });
});

describe("/oauth/authorize action — actor grant passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice" });
    mocks.getClient.mockResolvedValue({
      client_id: "doco_client_x",
      client_name: "Claude",
      redirect_uris: ["http://localhost:53682/callback"],
    });
    mocks.issueAuthorizationCode.mockResolvedValue({ code: "authcode_1" });
    mocks.loadApprovalGrantOptions.mockResolvedValue({ docos: [], workspaces: [] });
  });

  it("threads grant_type='actor' into the minted authorization code (unbound)", async () => {
    mocks.readOAuthApprovalGrants.mockResolvedValue(actorGrants());

    const res = await action({ request: approveRequest(UNBOUND_URL) });

    expect(res.status).toBe(302);
    expect(mocks.issueAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(mocks.issueAuthorizationCode.mock.calls[0]?.[0]).toMatchObject({
      grant_type: "actor",
      granted_doco_ids: [],
      granted_workspace_ids: [],
    });
  });

  // Alexander, 2026-10-08: one-click Allow (decision_01M4EQPJ6AKETJ1508W254DXVB).
  // The page asks for no token name; the connection goes by the client's name.
  it("issues the code with no token name", async () => {
    mocks.readOAuthApprovalGrants.mockResolvedValue(actorGrants());

    await action({ request: approveRequest(UNBOUND_URL) });

    expect(mocks.issueAuthorizationCode.mock.calls[0]?.[0]).not.toHaveProperty("token_name");
  });

  it("threads grant_type='regular' for a normal workspace grant", async () => {
    mocks.readOAuthApprovalGrants.mockResolvedValue(workspaceGrants("workspace_01ABC"));

    await action({ request: approveRequest(UNBOUND_URL) });

    expect(mocks.issueAuthorizationCode.mock.calls[0]?.[0]).toMatchObject({
      grant_type: "regular",
    });
  });
});
