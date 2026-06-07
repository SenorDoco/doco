import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipalAsync: vi.fn(),
  getOauthTokenForRequest: vi.fn(),
  getWorkspaceById: vi.fn(),
  principalReachesWorkspace: vi.fn(),
}));

vi.mock("@doco/db", () => ({ getWorkspaceById: mocks.getWorkspaceById }));
vi.mock("../doco-access.server", () => ({
  getOauthTokenForRequest: mocks.getOauthTokenForRequest,
}));
vi.mock("../session.server", () => ({ getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync }));
vi.mock("../workspace-mcp.server", () => ({
  principalReachesWorkspace: mocks.principalReachesWorkspace,
}));

import { gateUserMcp } from "../user-mcp.server";

const req = new Request("https://doco.to/mcp", { method: "POST" });

describe("gateUserMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_alice" });
    mocks.getOauthTokenForRequest.mockResolvedValue({ granted_workspace_ids: ["workspace_acme"] });
    mocks.getWorkspaceById.mockResolvedValue({ id: "workspace_acme", handle: "acme" });
    mocks.principalReachesWorkspace.mockResolvedValue(true);
  });

  it("pins the session to the token's lone granted workspace", async () => {
    const gate = await gateUserMcp(req);
    expect(gate).toEqual({
      ok: true,
      ctx: { workspaceId: "workspace_acme", workspaceHandle: "acme", principalId: "user_alice" },
    });
  });

  it("is unauthenticated without a principal", async () => {
    mocks.getCurrentPrincipalAsync.mockResolvedValue(null);
    expect(await gateUserMcp(req)).toMatchObject({ ok: false, kind: "unauthenticated" });
  });

  it("is unauthenticated without a bearer token (cookie alone can't pin a workspace)", async () => {
    mocks.getOauthTokenForRequest.mockResolvedValue(null);
    expect(await gateUserMcp(req)).toMatchObject({ ok: false, kind: "unauthenticated" });
  });

  it("forbids a token with no workspace scope", async () => {
    mocks.getOauthTokenForRequest.mockResolvedValue({ granted_workspace_ids: [] });
    expect(await gateUserMcp(req)).toMatchObject({ ok: false, kind: "forbidden" });
  });

  it("forbids when the human no longer reaches the token's workspace", async () => {
    mocks.principalReachesWorkspace.mockResolvedValue(false);
    expect(await gateUserMcp(req)).toMatchObject({ ok: false, kind: "forbidden" });
  });
});
