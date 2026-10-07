// GET /api/v1/standing-orders.json: who may ask, which workspace and Docos
// the orders cover, the text rendering, and the query log row. The engine is
// stubbed; its own test runs it against a real database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  composeStandingOrders: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
  extractBearer: vi.fn(),
  isProjectToken: vi.fn(),
  validateProjectToken: vi.fn(),
  loadWorkspaceForRead: vi.fn(),
  lookupWorkspaceHandle: vi.fn(),
  recordQuery: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("~/lib/brief/standing-orders.server", () => ({
  composeStandingOrders: mocks.composeStandingOrders,
}));
vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
  extractBearer: mocks.extractBearer,
}));
vi.mock("~/lib/project-tokens.server", () => ({
  isProjectToken: mocks.isProjectToken,
  validateProjectToken: mocks.validateProjectToken,
}));
vi.mock("~/lib/workspace-helpers.server", () => ({
  loadWorkspaceForRead: mocks.loadWorkspaceForRead,
  lookupWorkspaceHandle: mocks.lookupWorkspaceHandle,
}));
vi.mock("~/lib/query-log.server", () => ({ recordQuery: mocks.recordQuery }));
vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn({ query: vi.fn() }),
}));

import { loader } from "../api.v1.standing-orders[.]json";

const ORDERS = {
  workspace: {
    id: "workspace_1",
    handle: "acme",
    name: "Acme",
    url: "https://doco.to/workspaces/acme",
  },
  constitution: "Ship small.",
  rules: [{ id: "rule_1" }],
  docos: [],
  changes: { since: "2026-09-25T12:00:00.000Z", items: [{ id: "decision_2" }], more: 0 },
  warnings: [],
  tokens: 40,
  text: "Standing orders for Acme (acme) · https://doco.to/workspaces/acme\n\n## Constitution\nShip small.",
};

function get(query: string, headers: Record<string, string> = {}): Promise<Response> {
  return loader({
    request: new Request(`https://doco.to/api/v1/standing-orders.json?${query}`, { headers }),
  });
}

describe("GET /api/v1/standing-orders.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractBearer.mockReturnValue(null);
    mocks.isProjectToken.mockReturnValue(false);
    mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_alice" });
    mocks.loadWorkspaceForRead.mockResolvedValue({
      workspace: { id: "workspace_1", handle: "acme" },
      myRole: "writer",
      docos: [{ id: "doco_1" }, { id: "doco_2" }],
    });
    mocks.composeStandingOrders.mockResolvedValue(ORDERS);
  });

  it("needs a caller, then a workspace", async () => {
    mocks.getCurrentPrincipalAsync.mockResolvedValue(null);
    expect((await get("workspace=acme")).status).toBe(401);
    mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_alice" });
    expect((await get("")).status).toBe(400);
  });

  it("covers the Docos a member can read, moves the window with since, and logs one query", async () => {
    const res = await get("workspace=acme&since=2026-10-01");
    expect(res.status).toBe(200);
    expect(mocks.loadWorkspaceForRead).toHaveBeenCalledWith("acme", "user_alice");
    expect(mocks.composeStandingOrders.mock.calls[0][1]).toEqual({
      workspaceId: "workspace_1",
      docoIds: ["doco_1", "doco_2"],
      origin: "https://doco.to",
    });
    expect(mocks.composeStandingOrders.mock.calls[0][2]).toEqual({ since: "2026-10-01" });
    expect(await res.json()).toEqual(ORDERS);
    expect(mocks.recordQuery.mock.calls[0].slice(1)).toEqual([
      { workspaceId: "workspace_1", docoId: null },
      "user_alice",
      { standing_orders: true, rules: 1, changes: 1, tokens: 40 },
    ]);
  });

  it("gives a reader who is no member the orders of the Docos they can read, constitution included", async () => {
    mocks.loadWorkspaceForRead.mockResolvedValue({
      workspace: { id: "workspace_1", handle: "acme" },
      myRole: null,
      docos: [{ id: "doco_1" }],
    });
    await get("workspace=acme");
    expect(mocks.composeStandingOrders.mock.calls[0][1]).toEqual({
      workspaceId: "workspace_1",
      docoIds: ["doco_1"],
      origin: "https://doco.to",
    });
  });

  // decision_01M4C2J610DPD028P55Q8X6VG2: a token reads as the person who made it.
  it("gives a project token its own workspace as its maker reads it, and no other", async () => {
    mocks.extractBearer.mockReturnValue("doco_pt_x");
    mocks.isProjectToken.mockReturnValue(true);
    mocks.validateProjectToken.mockResolvedValue({
      workspace_id: "workspace_9",
      created_by_user_id: "user_maker",
    });
    mocks.lookupWorkspaceHandle.mockResolvedValue("nine");
    mocks.loadWorkspaceForRead.mockResolvedValue({
      workspace: { id: "workspace_9", handle: "nine" },
      myRole: "reader",
      docos: [{ id: "doco_9" }],
    });
    const res = await get("format=text", { authorization: "Bearer doco_pt_x" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(ORDERS.text);
    expect(mocks.getCurrentPrincipalAsync).not.toHaveBeenCalled();
    expect(mocks.loadWorkspaceForRead).toHaveBeenCalledWith("nine", "user_maker");
    expect(mocks.composeStandingOrders.mock.calls[0][1]).toMatchObject({
      workspaceId: "workspace_9",
      docoIds: ["doco_9"],
    });
    expect(mocks.recordQuery.mock.calls[0][2]).toBeNull();
    expect((await get("workspace=nine", { authorization: "Bearer doco_pt_x" })).status).toBe(200);
    expect((await get("workspace=other", { authorization: "Bearer doco_pt_x" })).status).toBe(403);
  });
});
