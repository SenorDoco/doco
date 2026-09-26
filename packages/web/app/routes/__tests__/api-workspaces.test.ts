import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipalAsync: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  tokenReachableWorkspaceIdsForRequest: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  listWorkspacesForUser: mocks.listWorkspacesForUser,
}));

vi.mock("~/lib/doco-access.server", () => ({
  tokenReachableWorkspaceIdsForRequest: mocks.tokenReachableWorkspaceIdsForRequest,
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

describe("POST /api/v1/workspaces.json", () => {
  // Workspaces are created by people at /new-workspace; agents only get access
  // to ones that exist. The API has no create path for anyone, and the refusal
  // teaches the access model instead of a bare method error.
  it("refuses with 405 and points at the human create page", async () => {
    const request = new Request("https://doco.test/api/v1/workspaces.json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requested_id: "newws" }),
    });
    const response = await action({ request } as never);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("https://doco.test/new-workspace");
    expect(body.error).toMatch(/created by people/i);
  });
});
