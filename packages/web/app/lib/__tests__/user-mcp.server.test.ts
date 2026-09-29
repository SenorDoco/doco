import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipalAsync: vi.fn(),
  getOauthTokenForRequest: vi.fn(),
}));

vi.mock("../doco-access.server", () => ({
  getOauthTokenForRequest: mocks.getOauthTokenForRequest,
}));
vi.mock("../session.server", () => ({ getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync }));

import { gateUserMcp } from "../user-mcp.server";

const req = new Request("https://doco.to/mcp", { method: "POST" });

// The session's reach is whatever the token grants; every tool call replays the
// bearer, so the per-Doco routes enforce it. The gate only establishes who is
// calling, for every kind of token alike.
describe("gateUserMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_alice" });
    mocks.getOauthTokenForRequest.mockResolvedValue({ granted_workspace_ids: ["workspace_acme"] });
  });

  it("opens a session for a token scoped to one workspace", async () => {
    expect(await gateUserMcp(req)).toEqual({ ok: true, ctx: { principalId: "user_alice" } });
  });

  it("opens a session for a token scoped to several workspaces", async () => {
    mocks.getOauthTokenForRequest.mockResolvedValue({
      granted_doco_ids: [],
      granted_workspace_ids: ["workspace_acme", "workspace_beta"],
    });
    expect(await gateUserMcp(req)).toEqual({ ok: true, ctx: { principalId: "user_alice" } });
  });

  it("opens a session for a token scoped to specific Docos only", async () => {
    mocks.getOauthTokenForRequest.mockResolvedValue({
      granted_doco_ids: ["doco_1"],
      granted_workspace_ids: [],
    });
    expect(await gateUserMcp(req)).toEqual({ ok: true, ctx: { principalId: "user_alice" } });
  });

  it("opens a session for an actor ('all workspaces') token", async () => {
    mocks.getOauthTokenForRequest.mockResolvedValue({
      grant_type: "actor",
      actor_role: null,
      granted_workspace_ids: [],
    });
    expect(await gateUserMcp(req)).toEqual({ ok: true, ctx: { principalId: "user_alice" } });
  });

  it("is unauthenticated without a principal", async () => {
    mocks.getCurrentPrincipalAsync.mockResolvedValue(null);
    expect(await gateUserMcp(req)).toMatchObject({ ok: false, kind: "unauthenticated" });
  });

  it("is unauthenticated without a bearer token (a cookie alone is not enough)", async () => {
    mocks.getOauthTokenForRequest.mockResolvedValue(null);
    expect(await gateUserMcp(req)).toMatchObject({ ok: false, kind: "unauthenticated" });
  });
});
