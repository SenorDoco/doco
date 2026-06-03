import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAccessRequest: vi.fn(),
  decideAccessRequest: vi.fn(),
  getAccessRequest: vi.fn(),
  getDocoById: vi.fn(),
  getDocoByIdOrHandle: vi.fn(),
  getUserById: vi.fn(),
  listPendingAccessRequestsForDocos: vi.fn(),
  listPendingAccessRequestCountsByDoco: vi.fn(),
  upsertDocoUser: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
  loadApprovalGrantOptions: vi.fn(),
}));

const RANK: Record<string, number> = { reader: 0, writer: 1, owner: 2 };

vi.mock("@doco/db", () => ({
  createAccessRequest: mocks.createAccessRequest,
  decideAccessRequest: mocks.decideAccessRequest,
  getAccessRequest: mocks.getAccessRequest,
  getDocoById: mocks.getDocoById,
  getDocoByIdOrHandle: mocks.getDocoByIdOrHandle,
  getUserById: mocks.getUserById,
  listPendingAccessRequestsForDocos: mocks.listPendingAccessRequestsForDocos,
  listPendingAccessRequestCountsByDoco: mocks.listPendingAccessRequestCountsByDoco,
  upsertDocoUser: mocks.upsertDocoUser,
  // Real comparator so the "already has it" no-op path behaves correctly.
  roleAtLeast: (a: string, b: string) => RANK[a] >= RANK[b],
}));
vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal: mocks.listAccessibleDocoIdsForPrincipal,
}));
vi.mock("~/lib/oauth-approval-grants.server", () => ({
  loadApprovalGrantOptions: mocks.loadApprovalGrantOptions,
}));

import {
  approveAccessRequest,
  countPendingAccessRequestsForOwner,
  denyAccessRequest,
  listAccessRequestsForOwner,
  requestDocoAccess,
} from "../access-requests.server";

const DOCO = { id: "doco_1", handle: "acme", owner_id: "workspace_acme" };

describe("requestDocoAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDocoByIdOrHandle.mockResolvedValue(DOCO);
  });

  it("errors when the doco doesn't exist", async () => {
    mocks.getDocoByIdOrHandle.mockResolvedValue(null);
    expect(
      await requestDocoAccess({
        docoHandleOrId: "nope",
        requesterId: "u",
        requestedRole: "reader",
      }),
    ).toEqual({ ok: false, error: expect.stringContaining("No Doco") });
  });

  it("no-ops when the requester already holds the role or higher", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("writer");
    const r = await requestDocoAccess({
      docoHandleOrId: "acme",
      requesterId: "u",
      requestedRole: "reader",
    });
    expect(r).toEqual({ ok: true, alreadyHad: true, role: "writer", docoHandle: "acme" });
    expect(mocks.createAccessRequest).not.toHaveBeenCalled();
  });

  it("creates a pending request when the requester needs more", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("reader");
    mocks.createAccessRequest.mockResolvedValue({ id: "accreq_1", status: "pending" });
    const r = await requestDocoAccess({
      docoHandleOrId: "acme",
      requesterId: "u",
      requestedRole: "writer",
      reason: "need write",
    });
    expect(r.ok).toBe(true);
    expect(mocks.createAccessRequest).toHaveBeenCalledWith({
      doco_id: "doco_1",
      requester_id: "u",
      requested_role: "writer",
      reason: "need write",
    });
  });
});

describe("approveAccessRequest / denyAccessRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccessRequest.mockResolvedValue({
      id: "accreq_1",
      doco_id: "doco_1",
      requester_id: "u",
      requested_role: "writer",
      status: "pending",
    });
    mocks.getDocoById.mockResolvedValue(DOCO);
  });

  it("rejects a non-owner approver (403), writing no grant", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("writer");
    const r = await approveAccessRequest({ id: "accreq_1", approverId: "u2" });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(mocks.decideAccessRequest).not.toHaveBeenCalled();
    expect(mocks.upsertDocoUser).not.toHaveBeenCalled();
  });

  it("approves and writes the doco_users grant for an owner", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("owner");
    mocks.decideAccessRequest.mockResolvedValue({
      id: "accreq_1",
      doco_id: "doco_1",
      requester_id: "u",
      requested_role: "writer",
      status: "approved",
    });
    const r = await approveAccessRequest({ id: "accreq_1", approverId: "owner" });
    expect(r.ok).toBe(true);
    expect(mocks.decideAccessRequest).toHaveBeenCalledWith({
      id: "accreq_1",
      status: "approved",
      decided_by: "owner",
    });
    expect(mocks.upsertDocoUser).toHaveBeenCalledWith({
      doco_id: "doco_1",
      user_id: "u",
      role: "writer",
    });
  });

  it("returns 409 when the request was already decided", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("owner");
    mocks.decideAccessRequest.mockResolvedValue(null);
    const r = await approveAccessRequest({ id: "accreq_1", approverId: "owner" });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(mocks.upsertDocoUser).not.toHaveBeenCalled();
  });

  it("denies without writing a grant", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("owner");
    mocks.decideAccessRequest.mockResolvedValue({ id: "accreq_1", status: "denied" });
    const r = await denyAccessRequest({ id: "accreq_1", approverId: "owner" });
    expect(r.ok).toBe(true);
    expect(mocks.decideAccessRequest).toHaveBeenCalledWith({
      id: "accreq_1",
      status: "denied",
      decided_by: "owner",
    });
    expect(mocks.upsertDocoUser).not.toHaveBeenCalled();
  });

  it("404 when the request is unknown", async () => {
    mocks.getAccessRequest.mockResolvedValue(null);
    expect(await approveAccessRequest({ id: "x", approverId: "owner" })).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe("listAccessRequestsForOwner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns pending requests across owned docos, enriched with handle + login", async () => {
    mocks.loadApprovalGrantOptions.mockResolvedValue({
      docos: [{ id: "doco_1", handle: "acme" }],
      workspaces: [],
    });
    mocks.listPendingAccessRequestsForDocos.mockResolvedValue([
      {
        id: "accreq_1",
        doco_id: "doco_1",
        requester_id: "user_zoe",
        requested_role: "writer",
        reason: "ship it",
        created_at: "t",
      },
    ]);
    mocks.getUserById.mockResolvedValue({ id: "user_zoe", github_login: "zoe" });
    const items = await listAccessRequestsForOwner("owner");
    expect(items).toEqual([
      {
        id: "accreq_1",
        doco_id: "doco_1",
        doco_handle: "acme",
        requester_id: "user_zoe",
        requester_login: "zoe",
        requested_role: "writer",
        reason: "ship it",
        created_at: "t",
      },
    ]);
    expect(mocks.listPendingAccessRequestsForDocos).toHaveBeenCalledWith(["doco_1"]);
  });

  it("short-circuits to empty when the viewer owns nothing", async () => {
    mocks.loadApprovalGrantOptions.mockResolvedValue({ docos: [], workspaces: [] });
    expect(await listAccessRequestsForOwner("owner")).toEqual([]);
    expect(mocks.listPendingAccessRequestsForDocos).not.toHaveBeenCalled();
  });
});

describe("countPendingAccessRequestsForOwner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sums pending requests only on docos the viewer owns", async () => {
    mocks.listPendingAccessRequestCountsByDoco.mockResolvedValue([
      { doco_id: "doco_1", owner_id: "workspace_a", n: 2 },
      { doco_id: "doco_2", owner_id: "workspace_b", n: 3 },
    ]);
    mocks.listAccessibleDocoIdsForPrincipal.mockResolvedValue(["doco_1", "doco_2"]);
    // Owner on doco_1, mere writer on doco_2 — only doco_1's requests count.
    mocks.getDocoLevelRole.mockImplementation(async (meta: { docoId?: string }) =>
      meta.docoId === "doco_1" ? "owner" : "writer",
    );
    expect(await countPendingAccessRequestsForOwner("me")).toBe(2);
  });

  it("ignores pending requests on docos outside the viewer's accessible set", async () => {
    mocks.listPendingAccessRequestCountsByDoco.mockResolvedValue([
      { doco_id: "doco_1", owner_id: "workspace_a", n: 5 },
    ]);
    mocks.listAccessibleDocoIdsForPrincipal.mockResolvedValue([]);
    expect(await countPendingAccessRequestsForOwner("me")).toBe(0);
    // No need to resolve a role for a doco the viewer can't even see.
    expect(mocks.getDocoLevelRole).not.toHaveBeenCalled();
  });

  it("short-circuits to 0 without resolving access when nothing is pending", async () => {
    mocks.listPendingAccessRequestCountsByDoco.mockResolvedValue([]);
    expect(await countPendingAccessRequestsForOwner("me")).toBe(0);
    expect(mocks.listAccessibleDocoIdsForPrincipal).not.toHaveBeenCalled();
  });
});
