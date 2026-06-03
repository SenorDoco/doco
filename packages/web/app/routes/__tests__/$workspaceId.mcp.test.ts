import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gateWorkspaceMcp: vi.fn(),
  resolveDocoInWorkspace: vi.fn(),
  searchLoader: vi.fn(),
  captureAction: vi.fn(),
  edgesAction: vi.fn(),
  changesetsAction: vi.fn(),
  requestDocoAccess: vi.fn(),
  loadAgentIdentity: vi.fn(),
  getWorkspaceConstitutionsByIds: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getWorkspaceConstitutionsByIds: mocks.getWorkspaceConstitutionsByIds,
}));
vi.mock("~/lib/workspace-mcp.server", () => ({
  gateWorkspaceMcp: mocks.gateWorkspaceMcp,
  resolveDocoInWorkspace: mocks.resolveDocoInWorkspace,
}));
vi.mock("~/lib/access-requests.server", () => ({
  requestDocoAccess: mocks.requestDocoAccess,
}));
vi.mock("~/lib/agent-identity.server", () => ({ loadAgentIdentity: mocks.loadAgentIdentity }));
vi.mock("../$docoHandle.search[.]json", () => ({ loader: mocks.searchLoader }));
vi.mock("../$docoHandle.api.$type[.]json", () => ({ action: mocks.captureAction }));
vi.mock("../$docoHandle.api.edges[.]json", () => ({ action: mocks.edgesAction }));
vi.mock("../$docoHandle.api.changesets[.]json", () => ({ action: mocks.changesetsAction }));

import { action, loader } from "../$workspaceId.mcp";

const WORKSPACE = "workspace_acme";
const PARAMS = { workspaceId: WORKSPACE };
const BEARER = { authorization: "Bearer doco_at_test" };

function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://doco.to/${WORKSPACE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: test reads loosely-typed JSON-RPC bodies.
type Json = any;

describe("POST /<workspace-id>/mcp (per-workspace remote MCP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gateWorkspaceMcp.mockResolvedValue({
      ok: true,
      ctx: { workspaceId: WORKSPACE, workspaceHandle: "acme", principalId: "user_alice" },
    });
    // Default: any doco arg resolves to a same-named handle in this workspace.
    mocks.resolveDocoInWorkspace.mockImplementation(async (handleOrId: string) => ({
      ok: true,
      handle: handleOrId,
    }));
    // Default: workspace has no constitution unless a test sets one.
    mocks.getWorkspaceConstitutionsByIds.mockResolvedValue([]);
    vi.stubGlobal("fetch", mocks.fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("401 + WWW-Authenticate at this workspace's protected-resource metadata when unauthenticated", async () => {
    mocks.gateWorkspaceMcp.mockResolvedValue({
      ok: false,
      kind: "unauthenticated",
      message: "Unauthorized",
    });
    const res = await action({
      request: rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      params: PARAMS,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="https://doco.to/.well-known/oauth-protected-resource/${WORKSPACE}/mcp"`,
    );
  });

  it("404s an unknown workspace", async () => {
    mocks.gateWorkspaceMcp.mockResolvedValue({ ok: false, kind: "not_found", message: "nope" });
    const res = await action({
      request: rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      params: PARAMS,
    });
    expect(res.status).toBe(404);
  });

  it("403s a token bound to a different workspace", async () => {
    mocks.gateWorkspaceMcp.mockResolvedValue({
      ok: false,
      kind: "forbidden",
      message: "This token is not authorized for this workspace.",
    });
    const res = await action({
      request: rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, BEARER),
      params: PARAMS,
    });
    expect(res.status).toBe(403);
    const body: Json = await res.json();
    expect(body.error.message).toContain("not authorized for this workspace");
  });

  it("initialize advertises the workspace binding in its instructions", async () => {
    const res = await action({
      request: rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, BEARER),
      params: PARAMS,
    });
    const body: Json = await res.json();
    expect(body.result.serverInfo.name).toBe("doco");
    expect(body.result.instructions).toContain("bound to a single Doco Workspace");
    expect(body.result.instructions).toContain("no other");
  });

  it("tools/list advertises whoami + read + write tools", async () => {
    const res = await action({
      request: rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, BEARER),
      params: PARAMS,
    });
    const body: Json = await res.json();
    expect(body.result.tools.map((t: Json) => t.name)).toEqual([
      "doco_whoami",
      "doco_search",
      "doco_get",
      "doco_capture",
      "doco_relate",
      "doco_changeset",
      "doco_request_access",
    ]);
  });

  it("doco_whoami reports the bound workspace and only its docos", async () => {
    mocks.loadAgentIdentity.mockResolvedValue({
      user_id: "user_alice",
      username: "alice",
      type: "person",
      credential: null,
      indicator_prefix: "[🔮 Doco @alice]",
      grants: [
        { scope: "workspace", id: WORKSPACE, label: "acme", role: "owner" },
        { scope: "doco", id: "doco_1", label: "acme/proj1", role: "writer" },
        // A doco in a different workspace must NOT surface here.
        { scope: "doco", id: "doco_2", label: "other/proj2", role: "reader" },
      ],
    });
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 30,
          method: "tools/call",
          params: { name: "doco_whoami", arguments: {} },
        },
        BEARER,
      ),
      params: PARAMS,
    });
    const body: Json = await res.json();
    const text: string = body.result.content[0].text;
    expect(text).toContain("bound to workspace acme");
    expect(text).toContain("acme/proj1: writer");
    expect(text).not.toContain("other/proj2");
  });

  it("doco_whoami surfaces the workspace constitution (scoped to this workspace)", async () => {
    mocks.loadAgentIdentity.mockResolvedValue({
      user_id: "user_alice",
      username: "alice",
      type: "person",
      credential: null,
      indicator_prefix: "[🔮 Doco @alice]",
      grants: [{ scope: "workspace", id: WORKSPACE, label: "acme", role: "owner" }],
    });
    mocks.getWorkspaceConstitutionsByIds.mockResolvedValue([
      {
        workspace_id: WORKSPACE,
        workspace_handle: "acme",
        constitution: "Ship behind flags. Write the decision down.",
      },
    ]);
    const res = await action({
      request: rpc(
        { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "doco_whoami" } },
        BEARER,
      ),
      params: PARAMS,
    });
    const body: Json = await res.json();
    expect(mocks.getWorkspaceConstitutionsByIds).toHaveBeenCalledWith([WORKSPACE]);
    expect(body.result.content[0].text).toContain("Workspace constitution");
    expect(body.result.content[0].text).toContain("Ship behind flags. Write the decision down.");
    expect(body.result.structuredContent.workspace_constitution).toContain("Ship behind flags");
  });

  it("doco_whoami omits the constitution section when the workspace has none", async () => {
    mocks.loadAgentIdentity.mockResolvedValue({
      user_id: "user_alice",
      username: "alice",
      type: "person",
      credential: null,
      indicator_prefix: "[🔮 Doco @alice]",
      grants: [{ scope: "workspace", id: WORKSPACE, label: "acme", role: "owner" }],
    });
    mocks.getWorkspaceConstitutionsByIds.mockResolvedValue([]);
    const res = await action({
      request: rpc(
        { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "doco_whoami" } },
        BEARER,
      ),
      params: PARAMS,
    });
    const body: Json = await res.json();
    expect(body.result.content[0].text).not.toContain("Workspace constitution");
    expect(body.result.structuredContent.workspace_constitution).toBeNull();
  });

  it("doco_search delegates to the search loader, replaying the bearer", async () => {
    mocks.searchLoader.mockResolvedValue(Response.json({ count: 1, hits: [{ id: "decision_1" }] }));
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "doco_search", arguments: { query: "auth", doco: "proj1", limit: 5 } },
        },
        BEARER,
      ),
      params: PARAMS,
    });
    const body: Json = await res.json();
    expect(mocks.resolveDocoInWorkspace).toHaveBeenCalledWith("proj1", WORKSPACE);
    const callArg: Json = mocks.searchLoader.mock.calls[0][0];
    expect(callArg.params).toEqual({ docoHandle: "proj1" });
    expect(callArg.request.headers.get("authorization")).toBe("Bearer doco_at_test");
    expect(body.result.structuredContent.count).toBe(1);
  });

  it("refuses a tool whose doco is in another workspace (no delegation)", async () => {
    mocks.resolveDocoInWorkspace.mockResolvedValue({
      ok: false,
      message: `Doco "elsewhere" is not in this workspace.`,
    });
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "doco_search", arguments: { query: "x", doco: "elsewhere" } },
        },
        BEARER,
      ),
      params: PARAMS,
    });
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("not in this workspace");
    expect(mocks.searchLoader).not.toHaveBeenCalled();
  });

  it("doco_capture normalizes a singular type and delegates the POST", async () => {
    mocks.captureAction.mockResolvedValue(
      Response.json({ ok: true, id: "decision_1" }, { status: 201 }),
    );
    await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "doco_capture",
            arguments: { doco: "proj1", type: "decision", body: { decision: "X", question: "Y?" } },
          },
        },
        BEARER,
      ),
      params: PARAMS,
    });
    const callArg: Json = mocks.captureAction.mock.calls[0][0];
    expect(callArg.params).toEqual({ docoHandle: "proj1", type: "decisions" });
    expect(callArg.request.url).toContain("/proj1/api/decisions.json");
  });

  it("doco_changeset requires a non-empty operations array", async () => {
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: { name: "doco_changeset", arguments: { doco: "proj1", operations: [] } },
        },
        BEARER,
      ),
      params: PARAMS,
    });
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(mocks.changesetsAction).not.toHaveBeenCalled();
  });

  it("doco_request_access constrains to a doco in this workspace", async () => {
    mocks.requestDocoAccess.mockResolvedValue({
      ok: true,
      alreadyHad: false,
      request: { id: "accreq_1", requested_role: "writer" },
      docoHandle: "proj1",
    });
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "tools/call",
          params: { name: "doco_request_access", arguments: { doco: "proj1", role: "writer" } },
        },
        BEARER,
      ),
      params: PARAMS,
    });
    const body: Json = await res.json();
    expect(mocks.resolveDocoInWorkspace).toHaveBeenCalledWith("proj1", WORKSPACE);
    expect(mocks.requestDocoAccess).toHaveBeenCalledWith({
      docoHandleOrId: "proj1",
      requesterId: "user_alice",
      requestedRole: "writer",
      reason: null,
    });
    expect(body.result.content[0].text).toContain("Requested writer");
  });

  it("a notification (no id) gets 202 and no body", async () => {
    const res = await action({
      request: rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, BEARER),
      params: PARAMS,
    });
    expect(res.status).toBe(202);
  });

  it("GET is 405 — no SSE server stream", () => {
    expect(loader().status).toBe(405);
  });
});
