import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  getDocoLevelRole: vi.fn(),
  addConnection: vi.fn(),
  removeConnection: vi.fn(),
  getDocoConnectionsContext: vi.fn(),
  listConnections: vi.fn(),
  backfill: vi.fn(),
}));

vi.mock("@doco/db", () => {
  const rank = { reader: 1, writer: 2, owner: 3 } as const;
  return {
    roleAtLeast: (have: keyof typeof rank | null, want: keyof typeof rank) =>
      Boolean(have && rank[have] >= rank[want]),
  };
});
vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
  getDocoLevelRole: mocks.getDocoLevelRole,
}));
vi.mock("~/lib/db.server", () => ({ docoPath: (h: string) => `/tmp/docos/${h}` }));
vi.mock("~/lib/github-backfill.server", () => ({ backfillRepoPullRequests: mocks.backfill }));
vi.mock("~/lib/github-connection.server", () => ({
  // Pure slug parser re-implemented inline so the factory stays hoist-safe;
  // the canonical impl is unit-tested in github-connection.server.test.ts.
  parseRepoSlug: (input: string) => {
    const t = input
      .trim()
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(t);
    return m ? { owner: m[1], name: m[2] } : null;
  },
  addConnection: mocks.addConnection,
  removeConnection: mocks.removeConnection,
  getDocoConnectionsContext: mocks.getDocoConnectionsContext,
  listConnections: mocks.listConnections,
}));

import { action } from "../$docoHandle.api.github[.]json";

function req(body: Record<string, unknown>): Request {
  return new Request("https://doco.test/acme/api/github.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = { docoHandle: "store-doco" } as never;

describe("github connection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDocoRouteForRead.mockResolvedValue({
      me: { id: "user_1" },
      meta: { docoId: "doco_1", ownerId: "organization_1", handle: "store-doco" },
    });
    mocks.getDocoLevelRole.mockResolvedValue("writer");
    mocks.addConnection.mockResolvedValue([]);
    mocks.removeConnection.mockResolvedValue([]);
  });

  it("connects a repo (normalizes the slug, adds the connection)", async () => {
    const res = await action({
      request: req({
        intent: "connect",
        repo: "https://github.com/acme/store",
        installation_id: 42,
      }),
      params,
    });
    expect(res.status).toBe(200);
    expect(mocks.addConnection).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({ repo: "acme/store", installation_id: 42 }),
    );
  });

  it("rejects a bad installation id", async () => {
    const res = await action({
      request: req({ intent: "connect", repo: "acme/store", installation_id: "nope" }),
      params,
    });
    expect(res.status).toBe(400);
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });

  it("disconnects a specific repo", async () => {
    const res = await action({
      request: req({ intent: "disconnect", repo: "acme/store" }),
      params,
    });
    expect(res.status).toBe(200);
    expect(mocks.removeConnection).toHaveBeenCalledWith("doco_1", "acme/store");
  });

  it("runs a backfill against a connected repo", async () => {
    mocks.getDocoConnectionsContext.mockResolvedValue({
      handle: "store-doco",
      orgHandle: "acme-org",
      connections: [{ repo: "acme/store", installation_id: 42 }],
    });
    mocks.backfill.mockResolvedValue({ total: 5, imported: 5, failed: 0 });
    const res = await action({ request: req({ intent: "backfill", repo: "acme/store" }), params });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, total: 5, imported: 5 });
    expect(mocks.backfill).toHaveBeenCalledWith(
      expect.objectContaining({
        docoId: "doco_1",
        owner: "acme",
        repo: "store",
        ownerSlug: "acme-org",
        installationId: 42,
      }),
    );
  });

  it("forbids a non-writer", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("reader");
    const res = await action({
      request: req({ intent: "connect", repo: "acme/store", installation_id: 42 }),
      params,
    });
    expect(res.status).toBe(403);
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });
});
