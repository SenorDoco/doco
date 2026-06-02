import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipalAsync: vi.fn(),
  getOauthTokenForRequest: vi.fn(),
  getWorkspaceById: vi.fn(),
  getWorkspaceRole: vi.fn(),
  getDocoByIdOrHandle: vi.fn(),
  query: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getWorkspaceById: mocks.getWorkspaceById,
  getWorkspaceRole: mocks.getWorkspaceRole,
  getDocoByIdOrHandle: mocks.getDocoByIdOrHandle,
  withClient: mocks.withClient,
}));
vi.mock("../session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
}));
vi.mock("../doco-access.server", () => ({
  getOauthTokenForRequest: mocks.getOauthTokenForRequest,
}));

import { gateWorkspaceMcp, resolveDocoInWorkspace } from "../workspace-mcp.server";

const WORKSPACE = "workspace_acme";

function req() {
  return new Request(`https://doco.to/${WORKSPACE}/mcp`, { method: "POST" });
}

describe("gateWorkspaceMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.getWorkspaceById.mockResolvedValue({ id: WORKSPACE, handle: "acme" });
    mocks.getOauthTokenForRequest.mockResolvedValue(null);
    mocks.getWorkspaceRole.mockResolvedValue("owner");
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.withClient.mockImplementation(async (cb) => cb({ query: mocks.query }));
  });

  it("rejects unauthenticated requests", async () => {
    mocks.getCurrentPrincipalAsync.mockResolvedValue(null);
    const r = await gateWorkspaceMcp(req(), WORKSPACE);
    expect(r).toMatchObject({ ok: false, kind: "unauthenticated" });
  });

  it("404s an unknown workspace", async () => {
    mocks.getWorkspaceById.mockResolvedValue(null);
    const r = await gateWorkspaceMcp(req(), WORKSPACE);
    expect(r).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("404s a non-workspace id without hitting the DB", async () => {
    const r = await gateWorkspaceMcp(req(), "doco_not_a_workspace");
    expect(r).toMatchObject({ ok: false, kind: "not_found" });
    expect(mocks.getWorkspaceById).not.toHaveBeenCalled();
  });

  it("admits a workspace-member cookie session (no bearer)", async () => {
    const r = await gateWorkspaceMcp(req(), WORKSPACE);
    expect(r).toEqual({
      ok: true,
      ctx: { workspaceId: WORKSPACE, workspaceHandle: "acme", principalId: "user_alice" },
    });
  });

  it("admits a token whose workspace grant matches the URL workspace", async () => {
    mocks.getOauthTokenForRequest.mockResolvedValue({
      granted_workspace_ids: [WORKSPACE],
      granted_doco_ids: [],
    });
    const r = await gateWorkspaceMcp(req(), WORKSPACE);
    expect(r.ok).toBe(true);
  });

  it("admits a token that reaches this workspace via a granted Doco", async () => {
    mocks.getOauthTokenForRequest.mockResolvedValue({
      granted_workspace_ids: [],
      granted_doco_ids: ["doco_1"],
    });
    // The doco-owned-by-this-workspace probe finds a row.
    mocks.query.mockResolvedValue({ rows: [{ "?column?": 1 }], rowCount: 1 });
    const r = await gateWorkspaceMcp(req(), WORKSPACE);
    expect(r.ok).toBe(true);
  });

  it("forbids a token bound to a DIFFERENT workspace", async () => {
    mocks.getOauthTokenForRequest.mockResolvedValue({
      granted_workspace_ids: ["workspace_other"],
      granted_doco_ids: [],
    });
    // No doco of this workspace is granted by the token.
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const r = await gateWorkspaceMcp(req(), WORKSPACE);
    expect(r).toMatchObject({ ok: false, kind: "forbidden" });
  });

  it("forbids a principal with no reach into the workspace", async () => {
    mocks.getWorkspaceRole.mockResolvedValue(null);
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 }); // no doco_users grant
    const r = await gateWorkspaceMcp(req(), WORKSPACE);
    expect(r).toMatchObject({ ok: false, kind: "forbidden" });
  });
});

describe("resolveDocoInWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves a Doco owned by the workspace", async () => {
    mocks.getDocoByIdOrHandle.mockResolvedValue({ handle: "proj", owner_id: WORKSPACE });
    expect(await resolveDocoInWorkspace("proj", WORKSPACE)).toEqual({ ok: true, handle: "proj" });
  });

  it("refuses a Doco in another workspace", async () => {
    mocks.getDocoByIdOrHandle.mockResolvedValue({ handle: "proj", owner_id: "workspace_other" });
    const r = await resolveDocoInWorkspace("proj", WORKSPACE);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toContain("not in this workspace");
  });

  it("refuses an unknown Doco", async () => {
    mocks.getDocoByIdOrHandle.mockResolvedValue(null);
    const r = await resolveDocoInWorkspace("nope", WORKSPACE);
    expect(r).toMatchObject({ ok: false });
  });
});
