import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// /mcp is the SAME route module as /<workspace-id>/mcp, selected by the
// ABSENCE of a :workspaceId param (params: {}), which routes to the user-level
// gate (lazy-imported gateUserMcp). We stub the shared dispatch deps the same
// way the workspace test does, plus gateUserMcp.
const mocks = vi.hoisted(() => ({
  gateUserMcp: vi.fn(),
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

vi.mock("~/lib/user-mcp.server", () => ({ gateUserMcp: mocks.gateUserMcp }));
vi.mock("@doco/db", () => ({
  getWorkspaceConstitutionsByIds: mocks.getWorkspaceConstitutionsByIds,
}));
vi.mock("~/lib/workspace-mcp.server", () => ({
  gateWorkspaceMcp: mocks.gateWorkspaceMcp,
  resolveDocoInWorkspace: mocks.resolveDocoInWorkspace,
}));
vi.mock("~/lib/access-requests.server", () => ({ requestDocoAccess: mocks.requestDocoAccess }));
vi.mock("~/lib/agent-identity.server", () => ({ loadAgentIdentity: mocks.loadAgentIdentity }));
vi.mock("../$docoHandle.search[.]json", () => ({ loader: mocks.searchLoader }));
vi.mock("../$docoHandle.api.$type[.]json", () => ({ action: mocks.captureAction }));
vi.mock("../$docoHandle.api.edges[.]json", () => ({ action: mocks.edgesAction }));
vi.mock("../$docoHandle.api.changesets[.]json", () => ({ action: mocks.changesetsAction }));

import { action } from "../$workspaceId.mcp";

const BEARER = { authorization: "Bearer doco_at_test" };

// The user-level route carries NO :workspaceId — that's what selects gateUserMcp.
function call(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return action({
    request: new Request("https://doco.to/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    params: {},
  });
}

// biome-ignore lint/suspicious/noExplicitAny: test reads loosely-typed JSON-RPC bodies.
type Json = any;

describe("POST /mcp (user-level remote MCP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gateUserMcp.mockResolvedValue({
      ok: true,
      ctx: { workspaceId: "workspace_acme", workspaceHandle: "acme", principalId: "user_alice" },
    });
    mocks.resolveDocoInWorkspace.mockImplementation(async (handleOrId: string) => ({
      ok: true,
      handle: handleOrId,
    }));
    mocks.getWorkspaceConstitutionsByIds.mockResolvedValue([]);
    vi.stubGlobal("fetch", mocks.fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("401 + WWW-Authenticate at the /mcp protected-resource metadata when unauthenticated", async () => {
    mocks.gateUserMcp.mockResolvedValue({
      ok: false,
      kind: "unauthenticated",
      message: "Unauthorized",
    });
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://doco.to/.well-known/oauth-protected-resource/mcp"',
    );
    // The user gate ran — not the workspace gate.
    expect(mocks.gateUserMcp).toHaveBeenCalledTimes(1);
    expect(mocks.gateWorkspaceMcp).not.toHaveBeenCalled();
  });

  it("dispatches tools/list through the shared core once the token pins a workspace", async () => {
    const res = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }, BEARER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    const names = body.result.tools.map((t: Json) => t.name);
    expect(names).toContain("doco_search");
    expect(names).toContain("doco_capture");
  });

  it("confines tools to the session workspace — a doco in another workspace is refused", async () => {
    mocks.resolveDocoInWorkspace.mockResolvedValue({
      ok: false,
      message: 'Doco "other" is not in this workspace.',
    });
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "doco_search", arguments: { doco: "other", q: "x" } },
      },
      BEARER,
    );
    const body = (await res.json()) as Json;
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body.result.content)).toContain("not in this workspace");
    expect(mocks.searchLoader).not.toHaveBeenCalled();
  });

  it("405s a non-POST", async () => {
    const res = await action({
      request: new Request("https://doco.to/mcp", { method: "GET" }),
      params: {},
    });
    expect(res.status).toBe(405);
  });
});
