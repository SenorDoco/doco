import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspaceRole: vi.fn(),
  getDocoByIdOrHandle: vi.fn(),
  query: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getWorkspaceRole: mocks.getWorkspaceRole,
  getDocoByIdOrHandle: mocks.getDocoByIdOrHandle,
  withClient: mocks.withClient,
}));

import { principalReachesWorkspace, resolveDocoInWorkspace } from "../workspace-mcp.server";

const WORKSPACE = "workspace_acme";

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

describe("principalReachesWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.withClient.mockImplementation(async (cb) => cb({ query: mocks.query }));
  });

  it("is true for a workspace member (no DB probe needed)", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("owner");
    expect(await principalReachesWorkspace("user_alice", WORKSPACE)).toBe(true);
    expect(mocks.withClient).not.toHaveBeenCalled();
  });

  it("is true for a non-member who holds a Doco grant inside the workspace", async () => {
    mocks.getWorkspaceRole.mockResolvedValue(null);
    mocks.query.mockResolvedValue({ rows: [{ "?column?": 1 }], rowCount: 1 });
    expect(await principalReachesWorkspace("user_alice", WORKSPACE)).toBe(true);
  });

  it("is false for a principal with no reach", async () => {
    mocks.getWorkspaceRole.mockResolvedValue(null);
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await principalReachesWorkspace("user_alice", WORKSPACE)).toBe(false);
  });
});
