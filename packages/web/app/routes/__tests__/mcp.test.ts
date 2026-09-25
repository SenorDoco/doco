import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The hosted MCP endpoint at /mcp. Identity + reach come from the token via the
// user-level gate (gateUserMcp); the tool surface + Doco confinement are shared.
// We stub the gate and the delegated route handlers so these tests exercise the
// JSON-RPC dispatch + tool wiring without a DB.
const mocks = vi.hoisted(() => ({
  gateUserMcp: vi.fn(),
  resolveDocoInWorkspace: vi.fn(),
  searchLoader: vi.fn(),
  captureAction: vi.fn(),
  edgesAction: vi.fn(),
  changesetsAction: vi.fn(),
  policiesAction: vi.fn(),
  policyIdAction: vi.fn(),
  requestDocoAccess: vi.fn(),
  loadAgentIdentity: vi.fn(),
  getWorkspaceConstitutionsByIds: vi.fn(),
  getDocoByIdOrHandle: vi.fn(),
  gatherAgentDebug: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("~/lib/user-mcp.server", () => ({ gateUserMcp: mocks.gateUserMcp }));
vi.mock("@doco/db", () => ({
  getWorkspaceConstitutionsByIds: mocks.getWorkspaceConstitutionsByIds,
  getDocoByIdOrHandle: mocks.getDocoByIdOrHandle,
}));
vi.mock("~/lib/workspace-mcp.server", () => ({
  resolveDocoInWorkspace: mocks.resolveDocoInWorkspace,
}));
vi.mock("~/lib/access-requests.server", () => ({ requestDocoAccess: mocks.requestDocoAccess }));
vi.mock("~/lib/agent-identity.server", () => ({ loadAgentIdentity: mocks.loadAgentIdentity }));
vi.mock("~/lib/agent-debug.server", () => ({ gatherAgentDebug: mocks.gatherAgentDebug }));
vi.mock("../$docoHandle.search[.]json", () => ({ loader: mocks.searchLoader }));
vi.mock("../$docoHandle.api.$type[.]json", () => ({ action: mocks.captureAction }));
vi.mock("../$docoHandle.api.edges[.]json", () => ({ action: mocks.edgesAction }));
vi.mock("../$docoHandle.api.changesets[.]json", () => ({ action: mocks.changesetsAction }));
vi.mock("../$docoHandle.api.policies[.]json", () => ({ action: mocks.policiesAction }));
vi.mock("../$docoHandle.api.policies.$id[.]json", () => ({ action: mocks.policyIdAction }));

import { action, loader } from "../mcp";

const WORKSPACE = "workspace_acme";
const BEARER = { authorization: "Bearer doco_at_test" };

function call(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return action({
    request: new Request("https://doco.to/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: test reads loosely-typed JSON-RPC bodies.
type Json = any;

describe("POST /mcp (hosted remote MCP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: a workspace-scoped session pinned to one workspace.
    mocks.gateUserMcp.mockResolvedValue({
      ok: true,
      ctx: { workspaceId: WORKSPACE, workspaceHandle: "acme", principalId: "user_alice" },
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
    expect(mocks.gateUserMcp).toHaveBeenCalledTimes(1);
  });

  it("403s a forbidden token", async () => {
    mocks.gateUserMcp.mockResolvedValue({
      ok: false,
      kind: "forbidden",
      message: "You don't have access to this workspace.",
    });
    const res = await call({ jsonrpc: "2.0", id: 1, method: "initialize" }, BEARER);
    expect(res.status).toBe(403);
    const body: Json = await res.json();
    expect(body.error.message).toContain("don't have access");
  });

  it("initialize describes the multi-workspace 'act as me' reach, not a single-workspace binding", async () => {
    const res = await call({ jsonrpc: "2.0", id: 7, method: "initialize" }, BEARER);
    const body = (await res.json()) as Json;
    const instructions: string = body.result.instructions;
    // The connection can reach every workspace you belong to — the old
    // "bound to a single workspace, token reaches no other" claim was false.
    expect(instructions).not.toContain("bound to a single Doco Workspace");
    expect(instructions).not.toContain("reaches\nno other");
    // It points the agent at the discovery tools for that reach.
    expect(instructions).toContain("doco_whoami");
    expect(instructions).toContain("list_workspaces");
    expect(body.result.serverInfo.name).toBe("doco");
    // The grant is the scope: use all of it, no one-at-a-time cap.
    expect(instructions).not.toMatch(/one Doco at a time/i);
    expect(instructions).toContain("Use all of it");
  });

  it("initialize maps a project to a Workspace, so a new project gets a new Workspace", async () => {
    const res = await call({ jsonrpc: "2.0", id: 8, method: "initialize" }, BEARER);
    const body = (await res.json()) as Json;
    const instructions: string = body.result.instructions;
    expect(instructions).toContain("One project = one Workspace");
    expect(instructions).toContain("/new-workspace");
  });

  it("tools/list advertises whoami + read + write tools", async () => {
    const res = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }, BEARER);
    const body: Json = await res.json();
    expect(body.result.tools.map((t: Json) => t.name)).toEqual([
      "doco_whoami",
      "list_workspaces",
      "doco_search",
      "doco_get",
      "doco_capture",
      "doco_relate",
      "doco_changeset",
      "doco_policy",
      "doco_request_access",
      "doco_agent_debug",
    ]);
  });

  it("doco_agent_debug is denied for non-superadmin credentials", async () => {
    mocks.loadAgentIdentity.mockResolvedValue({
      user_id: "user_alice",
      username: "alice",
      type: "person",
      credential: null,
      indicator_prefix: "[🔮 Doco @alice]",
      grants: [{ scope: "workspace", id: WORKSPACE, label: "acme", role: "owner" }],
    });
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 90,
        method: "tools/call",
        params: { name: "doco_agent_debug", arguments: { search: "BPMN" } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("superadmin");
    expect(mocks.gatherAgentDebug).not.toHaveBeenCalled();
  });

  it("doco_agent_debug returns production diagnostics for the superadmin", async () => {
    mocks.loadAgentIdentity.mockResolvedValue({
      user_id: "user_t",
      username: "torrenegra",
      type: "person",
      credential: null,
      indicator_prefix: "[🔮 Doco @torrenegra]",
      grants: [],
    });
    const report = {
      generated_at: "2026-06-08T00:00:00.000Z",
      limit: 20,
      recent_turns: [{ id: "atm_1", input_tokens: 1234 }],
      search_results: [{ conversation_id: "conversation_match", match_count: 1 }],
      conversation_analysis: null,
    };
    mocks.gatherAgentDebug.mockResolvedValue(report);
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 91,
        method: "tools/call",
        params: { name: "doco_agent_debug", arguments: { search: "wiring", limit: 5 } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(body.result.isError).toBeFalsy();
    expect(mocks.gatherAgentDebug).toHaveBeenCalledWith(
      expect.objectContaining({ search: "wiring", limit: 5 }),
    );
    expect(body.result.structuredContent).toEqual(report);
  });

  it("doco_whoami reports the pinned workspace and only its docos", async () => {
    mocks.loadAgentIdentity.mockResolvedValue({
      user_id: "user_alice",
      username: "alice",
      type: "person",
      credential: null,
      indicator_prefix: "[🔮 Doco @alice]",
      grants: [
        { scope: "workspace", id: WORKSPACE, label: "acme", role: "owner" },
        { scope: "doco", id: "doco_1", label: "acme/proj1", role: "writer" },
        // A doco in a different workspace must NOT surface on a pinned session.
        { scope: "doco", id: "doco_2", label: "other/proj2", role: "reader" },
      ],
    });
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: { name: "doco_whoami", arguments: {} },
      },
      BEARER,
    );
    const body: Json = await res.json();
    const text: string = body.result.content[0].text;
    expect(text).toContain("bound to workspace acme");
    expect(text).toContain("acme/proj1: writer");
    expect(text).not.toContain("other/proj2");
  });

  it("doco_whoami on an 'act as me' connection surfaces every workspace + doco", async () => {
    mocks.gateUserMcp.mockResolvedValue({
      ok: true,
      ctx: { workspaceId: "", workspaceHandle: "", principalId: "user_alice", allWorkspaces: true },
    });
    mocks.loadAgentIdentity.mockResolvedValue({
      user_id: "user_alice",
      username: "alice",
      type: "person",
      credential: null,
      indicator_prefix: "[🔮 Doco @alice]",
      grants: [
        { scope: "workspace", id: WORKSPACE, label: "acme", role: "owner" },
        { scope: "workspace", id: "workspace_beta", label: "beta", role: "writer" },
        { scope: "doco", id: "doco_2", label: "beta/proj2", role: "reader" },
      ],
    });
    const res = await call(
      { jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "doco_whoami" } },
      BEARER,
    );
    const body: Json = await res.json();
    const text: string = body.result.content[0].text;
    expect(text).toContain("act as me");
    expect(text).toContain("acme");
    expect(text).toContain("beta");
    expect(text).toContain("beta/proj2: reader");
    expect(body.result.structuredContent.all_workspaces).toBe(true);
  });

  it("doco_whoami surfaces the workspace constitution (scoped to the pinned workspace)", async () => {
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
    const res = await call(
      { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "doco_whoami" } },
      BEARER,
    );
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
    const res = await call(
      { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "doco_whoami" } },
      BEARER,
    );
    const body: Json = await res.json();
    expect(body.result.content[0].text).not.toContain("Workspace constitution");
    expect(body.result.structuredContent.workspace_constitution).toBeNull();
  });

  it("doco_search delegates to the search loader, replaying the bearer", async () => {
    mocks.searchLoader.mockResolvedValue(Response.json({ count: 1, hits: [{ id: "decision_1" }] }));
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "doco_search", arguments: { query: "auth", doco: "proj1", limit: 5 } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(mocks.resolveDocoInWorkspace).toHaveBeenCalledWith("proj1", WORKSPACE);
    const callArg: Json = mocks.searchLoader.mock.calls[0][0];
    expect(callArg.params).toEqual({ docoHandle: "proj1" });
    expect(callArg.request.headers.get("authorization")).toBe("Bearer doco_at_test");
    expect(body.result.structuredContent.count).toBe(1);
  });

  it("doco_search passes the server-built `display` lines through to the agent", async () => {
    // The route hands back ready-to-paste protocol lines; the MCP layer must
    // surface them so the agent echoes rather than manufactures the format.
    mocks.searchLoader.mockResolvedValue(
      Response.json({
        count: 1,
        hits: [{ id: "decision_1" }],
        display: {
          prefix: "[🔮 Doco @alice]",
          found: "[🔮 Doco @alice] 1 relevant nodes found (0.4s)",
          tally: "[🔮 Doco @alice] proj1: **0** nodes added/updated",
        },
      }),
    );
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 44,
        method: "tools/call",
        params: { name: "doco_search", arguments: { query: "auth", doco: "proj1" } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(body.result.structuredContent.display.found).toBe(
      "[🔮 Doco @alice] 1 relevant nodes found (0.4s)",
    );
    expect(body.result.structuredContent.display.tally).toContain("**0** nodes added/updated");
  });

  it("the doco_search tool description tells agents to paste the display lines verbatim", async () => {
    // Durable reinforcement: tool descriptions re-enter context on every
    // tools/list, unlike serverInfo.instructions (delivered once at connect).
    const res = await call({ jsonrpc: "2.0", id: 45, method: "tools/list" }, BEARER);
    const body: Json = await res.json();
    const search = body.result.tools.find((t: Json) => t.name === "doco_search");
    expect(search.description).toContain("display.found");
    expect(search.description).toContain("display.tally");
    const capture = body.result.tools.find((t: Json) => t.name === "doco_capture");
    expect(capture.description).toContain("footer_lines");
  });

  it("confines tools to the session workspace — a doco in another workspace is refused", async () => {
    mocks.resolveDocoInWorkspace.mockResolvedValue({
      ok: false,
      message: 'Doco "elsewhere" is not in this workspace.',
    });
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "doco_search", arguments: { query: "x", doco: "elsewhere" } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("not in this workspace");
    expect(mocks.searchLoader).not.toHaveBeenCalled();
  });

  it("doco_capture normalizes a singular type and delegates the POST", async () => {
    mocks.captureAction.mockResolvedValue(
      Response.json({ ok: true, id: "decision_1" }, { status: 201 }),
    );
    await call(
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
    );
    const callArg: Json = mocks.captureAction.mock.calls[0][0];
    expect(callArg.params).toEqual({ docoHandle: "proj1", type: "decisions" });
    expect(callArg.request.url).toContain("/proj1/api/decisions.json");
  });

  it("doco_changeset requires a non-empty operations array", async () => {
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "doco_changeset", arguments: { doco: "proj1", operations: [] } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(mocks.changesetsAction).not.toHaveBeenCalled();
  });

  it("doco_policy without an id POSTs the body to the policies create route", async () => {
    mocks.policiesAction.mockResolvedValue(
      Response.json({ ok: true, id: "policy_1" }, { status: 201 }),
    );
    await call(
      {
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: {
          name: "doco_policy",
          arguments: {
            doco: "proj1",
            body: { kind: "suggestion", agent_instruction: "Prefer examples." },
          },
        },
      },
      BEARER,
    );
    expect(mocks.policyIdAction).not.toHaveBeenCalled();
    const callArg: Json = mocks.policiesAction.mock.calls[0][0];
    expect(callArg.params).toEqual({ docoHandle: "proj1" });
    expect(callArg.request.method).toBe("POST");
    expect(callArg.request.url).toContain("/proj1/api/policies.json");
    expect(callArg.request.headers.get("authorization")).toBe("Bearer doco_at_test");
  });

  it("doco_policy with an id PATCHes the body to the per-policy modify route", async () => {
    mocks.policyIdAction.mockResolvedValue(
      Response.json({ ok: true, id: "policy_2", superseded: "policy_1" }, { status: 201 }),
    );
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: {
          name: "doco_policy",
          arguments: { doco: "proj1", id: "policy_1", body: { lifecycle: "retired" } },
        },
      },
      BEARER,
    );
    expect(mocks.policiesAction).not.toHaveBeenCalled();
    const callArg: Json = mocks.policyIdAction.mock.calls[0][0];
    expect(callArg.params).toEqual({ docoHandle: "proj1", id: "policy_1" });
    expect(callArg.request.method).toBe("PATCH");
    expect(callArg.request.url).toContain("/proj1/api/policies/policy_1.json");
    const body: Json = await res.json();
    expect(body.result.structuredContent.superseded).toBe("policy_1");
  });

  it("doco_request_access constrains to a doco in this workspace", async () => {
    mocks.requestDocoAccess.mockResolvedValue({
      ok: true,
      alreadyHad: false,
      request: { id: "accreq_1", requested_role: "writer" },
      docoHandle: "proj1",
    });
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "doco_request_access", arguments: { doco: "proj1", role: "writer" } },
      },
      BEARER,
    );
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
    const res = await call({ jsonrpc: "2.0", method: "notifications/initialized" }, BEARER);
    expect(res.status).toBe(202);
  });

  it("405s a non-POST", async () => {
    const res = await action({ request: new Request("https://doco.to/mcp", { method: "GET" }) });
    expect(res.status).toBe(405);
  });

  it("GET loader is 405 — no SSE server stream", () => {
    expect(loader().status).toBe(405);
  });
});
