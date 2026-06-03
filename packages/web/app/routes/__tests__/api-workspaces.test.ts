import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addWorkspaceByHandle: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
  isSenorDocoRequest: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  tokenReachableWorkspaceIdsForRequest: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  listWorkspacesForUser: mocks.listWorkspacesForUser,
}));

vi.mock("~/lib/doco-access.server", () => ({
  isSenorDocoRequest: mocks.isSenorDocoRequest,
  tokenReachableWorkspaceIdsForRequest: mocks.tokenReachableWorkspaceIdsForRequest,
}));

vi.mock("~/lib/redeem.server", () => ({
  addWorkspaceByHandle: mocks.addWorkspaceByHandle,
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
}));

import { action, loader } from "../api.v1.workspaces[.]json";

const ORGS = [
  { id: "workspace_torre", handle: "torre", name: "Torre", member_count: 3 },
  { id: "workspace_meta", handle: "meta-doco", name: "Meta Doco", member_count: 2 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_alice", username: "alice" });
  mocks.listWorkspacesForUser.mockResolvedValue(ORGS);
  mocks.isSenorDocoRequest.mockReturnValue(false);
});

describe("GET /api/v1/workspaces.json", () => {
  it("lists every membership workspace for a cookie session (no token scope-down)", async () => {
    mocks.tokenReachableWorkspaceIdsForRequest.mockResolvedValue(null);
    const request = new Request("https://doco.test/api/v1/workspaces.json");
    const response = await loader({ request } as never);
    const body = (await response.json()) as { workspaces: { id: string; handle: string }[] };
    expect(body.workspaces.map((o) => o.handle)).toEqual(["meta-doco", "torre"]);
  });

  it("hides workspaces the OAuth token cannot reach (cross-workspace leak fix)", async () => {
    mocks.tokenReachableWorkspaceIdsForRequest.mockResolvedValue(new Set(["workspace_torre"]));
    const request = new Request("https://doco.test/api/v1/workspaces.json", {
      headers: { Authorization: "Bearer doco_at_x" },
    });
    const response = await loader({ request } as never);
    const body = (await response.json()) as { workspaces: { id: string }[] };
    expect(body.workspaces.map((o) => o.id)).toEqual(["workspace_torre"]);
  });
});

describe("POST /api/v1/workspaces.json — Señor Doco owner cap", () => {
  function postRequest(): Request {
    return new Request("https://doco.test/api/v1/workspaces.json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requested_id: "newws" }),
    });
  }

  it("403s a Señor Doco request — creating a workspace would confer owner", async () => {
    mocks.isSenorDocoRequest.mockReturnValue(true);
    const response = await action({ request: postRequest() } as never);
    expect(response.status).toBe(403);
    expect(mocks.addWorkspaceByHandle).not.toHaveBeenCalled();
  });

  it("lets a human create a workspace", async () => {
    mocks.addWorkspaceByHandle.mockResolvedValue({ id: "workspace_new", handle: "newws" });
    const response = await action({ request: postRequest() } as never);
    expect(response.status).toBe(201);
    expect(mocks.addWorkspaceByHandle).toHaveBeenCalledTimes(1);
  });
});
