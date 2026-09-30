import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstPersonLines } from "~/lib/__tests__/first-person";

// The hosted MCP endpoint at /mcp. Identity + reach come from the token via the
// user-level gate (gateUserMcp); the tool surface + Doco confinement are shared.
// We stub the gate and the delegated route handlers so these tests exercise the
// JSON-RPC dispatch + tool wiring without a DB.
const mocks = vi.hoisted(() => ({
  gateUserMcp: vi.fn(),
  searchLoader: vi.fn(),
  captureAction: vi.fn(),
  edgesAction: vi.fn(),
  changesetsAction: vi.fn(),
  policiesAction: vi.fn(),
  policyIdAction: vi.fn(),
  createDocoAction: vi.fn(),
  resolveWorkspaceByHandle: vi.fn(),
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
vi.mock("~/lib/access-requests.server", () => ({ requestDocoAccess: mocks.requestDocoAccess }));
vi.mock("~/lib/agent-identity.server", () => ({ loadAgentIdentity: mocks.loadAgentIdentity }));
vi.mock("~/lib/agent-debug.server", () => ({ gatherAgentDebug: mocks.gatherAgentDebug }));
vi.mock("../$docoHandle.search[.]json", () => ({ loader: mocks.searchLoader }));
vi.mock("../$docoHandle.api.$type[.]json", () => ({ action: mocks.captureAction }));
vi.mock("../$docoHandle.api.edges[.]json", () => ({ action: mocks.edgesAction }));
vi.mock("../$docoHandle.api.changesets[.]json", () => ({ action: mocks.changesetsAction }));
vi.mock("../$docoHandle.api.policies[.]json", () => ({ action: mocks.policiesAction }));
vi.mock("../$docoHandle.api.policies.$id[.]json", () => ({ action: mocks.policyIdAction }));
vi.mock("../api.v1.docos[.]json", () => ({ action: mocks.createDocoAction }));
vi.mock("~/lib/workspace-helpers.server", () => ({
  resolveWorkspaceByHandle: mocks.resolveWorkspaceByHandle,
}));

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
    // Every token takes the same path: the gate names the caller, and each tool
    // call replays the bearer so the per-Doco routes enforce the grant.
    mocks.gateUserMcp.mockResolvedValue({ ok: true, ctx: { principalId: "user_alice" } });
    mocks.getDocoByIdOrHandle.mockImplementation(async (handleOrId: string) => ({
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

  it("initialize describes the multi-workspace 'all workspaces' reach, not a single-workspace binding", async () => {
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

  it("initialize has agents create a workspace's Docos themselves, never send the user to do it", async () => {
    const res = await call({ jsonrpc: "2.0", id: 8, method: "initialize" }, BEARER);
    const body = (await res.json()) as Json;
    const instructions: string = body.result.instructions;
    expect(instructions).toContain("doco_create");
    expect(instructions).not.toMatch(/Docos from the\s+workspace page/);
  });

  it("doco_create resolves a workspace handle and POSTs to the create route, replaying the bearer", async () => {
    mocks.resolveWorkspaceByHandle.mockResolvedValue({ id: "workspace_acme", handle: "acme" });
    mocks.createDocoAction.mockResolvedValue(
      Response.json(
        {
          id: "doco_1",
          handle: "acme-bugs",
          workspace_id: "workspace_acme",
          qualified_handle: "acme/acme-bugs",
        },
        { status: 201 },
      ),
    );
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: {
          name: "doco_create",
          arguments: {
            workspace: "acme",
            name: "acme-bugs",
            template: "bugs",
            goal: "Track bugs.",
          },
        },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.handle).toBe("acme-bugs");
    const req: Request = mocks.createDocoAction.mock.calls[0][0].request;
    expect(req.url).toBe("https://doco.to/api/v1/docos.json");
    expect(req.headers.get("authorization")).toBe("Bearer doco_at_test");
    expect(await req.json()).toEqual({
      workspace_id: "workspace_acme",
      name: "acme-bugs",
      template_handle: "bugs",
      goal: "Track bugs.",
    });
  });

  it("doco_create takes a workspace id as is, and passes the route's refusal through", async () => {
    mocks.createDocoAction.mockResolvedValue(
      Response.json(
        { error: "This connection holds 'writer' on this workspace." },
        { status: 403 },
      ),
    );
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "doco_create", arguments: { workspace: "workspace_acme", name: "x" } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(mocks.resolveWorkspaceByHandle).not.toHaveBeenCalled();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("holds 'writer' on this workspace");
  });

  it("doco_create refuses an unknown workspace before calling the route", async () => {
    mocks.resolveWorkspaceByHandle.mockResolvedValue(null);
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: { name: "doco_create", arguments: { workspace: "nowhere", name: "x" } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Workspace "nowhere" not found');
    expect(mocks.createDocoAction).not.toHaveBeenCalled();
  });

  it("initialize states the baseline duties: load context, document decisions, record the conversation", async () => {
    const res = await call({ jsonrpc: "2.0", id: 9, method: "initialize" }, BEARER);
    const body = (await res.json()) as Json;
    const instructions: string = body.result.instructions;
    expect(instructions).toContain("Load context first");
    expect(instructions).toContain("Document every decision");
    expect(instructions).toContain("Record the conversation");
    expect(instructions).not.toMatch(/does not mandate captures/i);
  });

  it("initialize leaves the agent's voice alone, and every tool description avoids the first person", async () => {
    const res = await call({ jsonrpc: "2.0", id: 9, method: "initialize" }, BEARER);
    const body = (await res.json()) as Json;
    const instructions: string = body.result.instructions;
    expect(instructions).not.toMatch(/first person/i);
    expect(firstPersonLines(instructions)).toEqual([]);
    const tools = await call({ jsonrpc: "2.0", id: 10, method: "tools/list" }, BEARER);
    const list = (await tools.json()) as Json;
    for (const tool of list.result.tools as Json[]) {
      expect(firstPersonLines(String(tool.description))).toEqual([]);
    }
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
      "doco_create",
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

  it("doco_whoami lists every workspace and Doco the token grants, across workspaces", async () => {
    mocks.loadAgentIdentity.mockResolvedValue({
      user_id: "user_alice",
      username: "alice",
      type: "person",
      credential: null,
      indicator_prefix: "[🔮 Doco @alice]",
      grants: [
        { scope: "workspace", id: WORKSPACE, label: "acme", role: "owner" },
        { scope: "workspace", id: "workspace_beta", label: "beta", role: "writer" },
        { scope: "doco", id: "doco_1", label: "acme/proj1", role: "owner" },
        { scope: "doco", id: "doco_3", label: "gamma/proj3", role: "reader" },
      ],
    });
    const res = await call(
      { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "doco_whoami" } },
      BEARER,
    );
    const body: Json = await res.json();
    const text: string = body.result.content[0].text;
    expect(text).toContain("acme");
    expect(text).toContain("beta");
    expect(text).toContain("acme/proj1: owner");
    expect(text).toContain("gamma/proj3: reader");
    expect(text).not.toContain("bound to workspace");
    expect(body.result.structuredContent.grants).toHaveLength(4);
  });

  it("doco_whoami surfaces the constitution of every reachable workspace", async () => {
    mocks.loadAgentIdentity.mockResolvedValue({
      user_id: "user_alice",
      username: "alice",
      type: "person",
      credential: null,
      indicator_prefix: "[🔮 Doco @alice]",
      grants: [
        { scope: "workspace", id: WORKSPACE, label: "acme", role: "owner" },
        { scope: "workspace", id: "workspace_beta", label: "beta", role: "writer" },
      ],
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
    expect(mocks.getWorkspaceConstitutionsByIds).toHaveBeenCalledWith([
      WORKSPACE,
      "workspace_beta",
    ]);
    expect(body.result.content[0].text).toContain("Workspace constitution for acme");
    expect(body.result.content[0].text).toContain("Ship behind flags. Write the decision down.");
    expect(body.result.structuredContent.workspace_constitutions).toEqual([
      {
        workspace_id: WORKSPACE,
        workspace_handle: "acme",
        constitution: "Ship behind flags. Write the decision down.",
      },
    ]);
  });

  it("doco_whoami omits the constitution section when no workspace has one", async () => {
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
    expect(body.result.structuredContent.workspace_constitutions).toEqual([]);
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
    expect(mocks.getDocoByIdOrHandle).toHaveBeenCalledWith("proj1");
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

  it("refuses an unknown Doco before delegating", async () => {
    mocks.getDocoByIdOrHandle.mockResolvedValue(null);
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "doco_search", arguments: { query: "x", doco: "nowhere" } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Doco "nowhere" not found');
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

  it("doco_request_access resolves the Doco and files the request", async () => {
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
    expect(mocks.getDocoByIdOrHandle).toHaveBeenCalledWith("proj1");
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
