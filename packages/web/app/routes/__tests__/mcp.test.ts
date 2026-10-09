import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstPersonLines } from "~/lib/__tests__/first-person";
import { agentInstructions } from "~/lib/agent-instructions";

// The hosted MCP endpoint at /mcp. Identity + reach come from the token via the
// user-level gate (gateUserMcp); the tool surface + Doco confinement are shared.
// We stub the gate and the delegated route handlers so these tests exercise the
// JSON-RPC dispatch + tool wiring without a DB.
const mocks = vi.hoisted(() => ({
  gateUserMcp: vi.fn(),
  searchLoader: vi.fn(),
  briefLoader: vi.fn(),
  standingOrdersLoader: vi.fn(),
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
  hookTokenFor: vi.fn(),
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
vi.mock("~/lib/hook-tokens.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hook-tokens.server")>()),
  hookTokenFor: mocks.hookTokenFor,
}));
vi.mock("../$docoHandle.search[.]json", () => ({ loader: mocks.searchLoader }));
vi.mock("../api.v1.brief[.]json", () => ({ loader: mocks.briefLoader }));
vi.mock("../api.v1.standing-orders[.]json", () => ({ loader: mocks.standingOrdersLoader }));
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

/** A tool result's text, parsed: the routes' JSON, as the agent reads it. */
function resultJson(result: Json): Json {
  return JSON.parse(result.content[0].text);
}

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
    mocks.standingOrdersLoader.mockResolvedValue(
      Response.json({ error: "Name the workspace (workspace=<handle>)." }, { status: 400 }),
    );
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

  // Alexander, 2026-09-30: one agent-instructions template everywhere. The
  // server hands a connecting agent the same block /agents shows.
  it("initialize hands the agent the /agents instructions, verbatim", async () => {
    const res = await call({ jsonrpc: "2.0", id: 7, method: "initialize" }, BEARER);
    const body = (await res.json()) as Json;
    expect(body.result.serverInfo.name).toBe("doco");
    expect(body.result.instructions).toBe(agentInstructions("https://doco.to"));
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
    expect(resultJson(body.result).handle).toBe("acme-bugs");
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
      "doco_brief",
      "doco_search",
      "doco_get",
      "doco_capture",
      "doco_relate",
      "doco_changeset",
      "doco_policy",
      "doco_create",
      "doco_hook_token",
      "doco_request_access",
      "doco_agent_debug",
    ]);
  });

  // decision_01M4C2J610DPD028P55Q8X6VG2: any member's agent gets its person's
  // token for the Doco hook, the same one every call, without a person typing it.
  describe("doco_hook_token", () => {
    const identity = (grants: Json[]) => ({
      user_id: "user_alice",
      username: "alice",
      type: "person",
      credential: null,
      indicator_prefix: "[🔮 Doco @alice]",
      grants,
    });
    const acme = { scope: "workspace", id: WORKSPACE, label: "acme", role: "reader" };
    const beta = { scope: "workspace", id: "workspace_beta", label: "beta", role: "writer" };
    const hookToken = async (args: Record<string, unknown> = {}) =>
      (
        (await (
          await call(
            {
              jsonrpc: "2.0",
              id: 60,
              method: "tools/call",
              params: { name: "doco_hook_token", arguments: args },
            },
            BEARER,
          )
        ).json()) as Json
      ).result;

    beforeEach(() => {
      mocks.hookTokenFor.mockResolvedValue("doco_ht_alice");
    });

    it("hands the person's token for a workspace the connection reaches, with where to save it", async () => {
      mocks.loadAgentIdentity.mockResolvedValue(identity([acme, beta]));
      const result = await hookToken({ workspace: "acme" });
      expect(mocks.hookTokenFor).toHaveBeenCalledWith({
        workspace_id: WORKSPACE,
        user_id: "user_alice",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('"acme": "doco_ht_alice"');
      expect(result.content[0].text).toContain("`.gitignore`");
      // The whole install rides along, so the agent reads no other page;
      // and the text is the whole result, since Claude Code shows the model a
      // result's structuredContent in place of its text.
      expect(result.content[0].text).toContain(
        "curl -fsSL https://doco.to/agents/doco-hook.mjs -o .doco/hook.mjs",
      );
      expect(result.content[0].text).toContain("Claude Code: .claude/settings.json");
      expect(result.structuredContent).toBeUndefined();
    });

    it("takes the one workspace the connection reaches, and asks for a handle among several", async () => {
      mocks.loadAgentIdentity.mockResolvedValue(identity([acme]));
      expect((await hookToken()).content[0].text).toContain('"acme": "doco_ht_alice"');

      mocks.loadAgentIdentity.mockResolvedValue(identity([acme, beta]));
      const several = await hookToken();
      expect(several.isError).toBe(true);
      expect(several.content[0].text).toContain("workspace=<handle>");
      expect(mocks.hookTokenFor).toHaveBeenCalledTimes(1);
    });

    it("refuses a workspace the connection doesn't reach whole, since the token reads all of it", async () => {
      mocks.loadAgentIdentity.mockResolvedValue(
        identity([{ scope: "doco", id: "doco_1", label: "acme/proj1", role: "owner" }]),
      );
      const result = await hookToken({ workspace: "acme" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("doesn't reach the whole workspace acme");
      expect(mocks.hookTokenFor).not.toHaveBeenCalled();
    });
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
    expect(resultJson(body.result)).toEqual(report);
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
    expect(body.result.structuredContent).toBeUndefined();
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
  });

  // Since the Doco Brief (decision_01M3YYQ1JRBS04Z99KEP869F26): the standing
  // orders of the project's workspace come with the identity, so one call
  // orients the agent and loads what always applies there.
  it("doco_whoami carries the standing orders of the named workspace, replaying the bearer", async () => {
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
      { workspace_id: "workspace_beta", workspace_handle: "beta", constitution: "Beta's charter." },
    ]);
    mocks.standingOrdersLoader.mockResolvedValue(
      Response.json({
        workspace: { id: WORKSPACE, handle: "acme" },
        rules: [{ id: "rule_1" }],
        text: "Standing orders for Acme (acme)\n\n## Rules\n- rule_1 (rules) — Ship small.",
      }),
    );
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 33,
        method: "tools/call",
        params: { name: "doco_whoami", arguments: { workspace: "acme", since: "2026-10-01" } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    const req: Request = mocks.standingOrdersLoader.mock.calls[0][0].request;
    expect(req.url).toBe(
      "https://doco.to/api/v1/standing-orders.json?workspace=acme&since=2026-10-01",
    );
    expect(req.headers.get("authorization")).toBe("Bearer doco_at_test");
    const text: string = body.result.content[0].text;
    expect(text).toContain("Standing orders for Acme (acme)");
    expect(text).toContain("- rule_1 (rules) — Ship small.");
    // The orders carry acme's constitution; beta keeps its line.
    expect(mocks.getWorkspaceConstitutionsByIds).toHaveBeenCalledWith(["workspace_beta"]);
    expect(text).toContain("Workspace constitution for beta");
  });

  it("doco_whoami takes the one reachable workspace as the project's, and asks for a handle among several", async () => {
    const identity = {
      user_id: "user_alice",
      username: "alice",
      type: "person",
      credential: null,
      indicator_prefix: "[🔮 Doco @alice]",
      grants: [{ scope: "workspace", id: WORKSPACE, label: "acme", role: "owner" }],
    };
    mocks.loadAgentIdentity.mockResolvedValue(identity);
    mocks.standingOrdersLoader.mockResolvedValue(
      Response.json({
        workspace: { id: WORKSPACE, handle: "acme" },
        text: "Standing orders for Acme",
      }),
    );
    const one = await call(
      { jsonrpc: "2.0", id: 34, method: "tools/call", params: { name: "doco_whoami" } },
      BEARER,
    );
    expect((await one.json()).result.content[0].text).toContain("Standing orders for Acme");
    expect(mocks.standingOrdersLoader.mock.calls[0][0].request.url).toBe(
      "https://doco.to/api/v1/standing-orders.json?workspace=acme",
    );

    mocks.loadAgentIdentity.mockResolvedValue({
      ...identity,
      grants: [
        ...identity.grants,
        { scope: "workspace", id: "workspace_beta", label: "beta", role: "writer" },
      ],
    });
    const several = await call(
      { jsonrpc: "2.0", id: 35, method: "tools/call", params: { name: "doco_whoami" } },
      BEARER,
    );
    const text: string = (await several.json()).result.content[0].text;
    expect(text).toContain("Call doco_whoami with workspace=<handle>");
    expect(mocks.standingOrdersLoader).toHaveBeenCalledTimes(1);

    const unknown = await call(
      {
        jsonrpc: "2.0",
        id: 36,
        method: "tools/call",
        params: { name: "doco_whoami", arguments: { workspace: "gamma" } },
      },
      BEARER,
    );
    expect((await unknown.json()).result.content[0].text).toContain(
      "This connection reaches no workspace named gamma.",
    );
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
    expect(resultJson(body.result).count).toBe(1);
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
    expect(resultJson(body.result).display.found).toBe(
      "[🔮 Doco @alice] 1 relevant nodes found (0.4s)",
    );
    expect(resultJson(body.result).display.tally).toContain("**0** nodes added/updated");
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

  // Alexander, 2026-10-07: with the hook, forget about AGENTS.md. No project
  // keeps a copy of the instructions, so no tool names a version to check it
  // against: the hook loads them at the start of every session.
  it("names no agent instructions version in doco_brief's description", async () => {
    const res = await call({ jsonrpc: "2.0", id: 46, method: "tools/list" }, BEARER);
    const body: Json = await res.json();
    const brief = body.result.tools.find((t: Json) => t.name === "doco_brief");
    expect(brief.description).not.toContain("agent instructions are version");
  });

  // The brief spans every Doco the bearer can read, so the tool takes no
  // `doco`; the route narrows the reach to the grant. The agent reads the
  // text rendering, then the protocol lines; the JSON (three times the size,
  // which Claude Code would show in place of the text) stays home.
  it("doco_brief delegates to the brief route with the bearer and hands back the text", async () => {
    mocks.briefLoader.mockResolvedValue(
      Response.json({
        brief_id: "brief_1",
        items: [{ id: "rule_1", tier: "must_obey" }],
        text: "Doco brief brief_1\n\n## Must obey\n- rule_1",
        display: {
          found: "[🔮 Doco @alice] briefed: 1 items (0.5s)",
          tally: "[🔮 Doco @alice] brief: **0** nodes added/updated",
        },
      }),
    );
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 47,
        method: "tools/call",
        params: {
          name: "doco_brief",
          arguments: {
            about: "add a route",
            touching: ["app/routes/x.tsx", "#12"],
            budget: 800,
            target: "decisions",
            rerank: false,
          },
        },
      },
      BEARER,
    );
    const body: Json = await res.json();
    const callArg: Json = mocks.briefLoader.mock.calls[0][0];
    const url = new URL(callArg.request.url);
    expect(url.pathname).toBe("/api/v1/brief.json");
    expect(url.searchParams.get("about")).toBe("add a route");
    expect(url.searchParams.getAll("touching")).toEqual(["app/routes/x.tsx", "#12"]);
    expect(url.searchParams.get("budget")).toBe("800");
    expect(url.searchParams.get("target")).toBe("decisions");
    expect(url.searchParams.get("rerank")).toBe("0");
    expect(url.searchParams.get("synthesize")).toBeNull();
    expect(callArg.request.headers.get("authorization")).toBe("Bearer doco_at_test");
    expect(body.result.content[0].text).toBe(
      [
        "Doco brief brief_1\n\n## Must obey\n- rule_1",
        "",
        "display.found: [🔮 Doco @alice] briefed: 1 items (0.5s)",
        "display.tally: [🔮 Doco @alice] brief: **0** nodes added/updated",
      ].join("\n"),
    );
    expect(body.result.structuredContent).toBeUndefined();
  });

  it("doco_brief refuses a call that does not say what the agent is about to do", async () => {
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 48,
        method: "tools/call",
        params: { name: "doco_brief", arguments: { touching: ["a.ts"] } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("requires `about`");
    expect(mocks.briefLoader).not.toHaveBeenCalled();
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

  // 2026-10-09: doco_capture's description sent an agent to read
  // api/logs.txt before its first Log, and doco_get answered {}, since it
  // parsed every body as JSON. The agent then read the authoring contract to
  // learn the shape: two calls, minutes, for a body the description can name.
  it("doco_get hands back a .txt resource's text", async () => {
    mocks.fetchMock.mockResolvedValue(
      new Response("# Doco — Capture a Log (single call)", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
    const res = await call(
      {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "doco_get", arguments: { doco: "proj1", resource: "api/logs.txt" } },
      },
      BEARER,
    );
    const body: Json = await res.json();
    expect(mocks.fetchMock).toHaveBeenCalledWith(
      "https://doco.to/proj1/api/logs.txt",
      expect.anything(),
    );
    expect(body.result.content[0].text).toBe("# Doco — Capture a Log (single call)");
  });

  it("doco_capture's description names the body's fields and how to replace a node, with nothing to read first", async () => {
    const res = await call({ jsonrpc: "2.0", id: 23, method: "tools/list" }, BEARER);
    const body: Json = await res.json();
    const capture = body.result.tools.find((t: Json) => t.name === "doco_capture");
    expect(capture.description).toContain("a Log { prose, verb,\nhappened_at, outputs }");
    expect(capture.description).toContain("doco_changeset's supersede op");
    expect(capture.description).not.toContain("first");
    const changeset = body.result.tools.find((t: Json) => t.name === "doco_changeset");
    expect(changeset.description).not.toMatch(/atomic/i);
    expect(changeset.description).toContain("stop at the first that fails");
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
    expect(resultJson(body.result).superseded).toBe("policy_1");
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
