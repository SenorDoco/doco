import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipalAsync: vi.fn(),
  searchLoader: vi.fn(),
  captureAction: vi.fn(),
  edgesAction: vi.fn(),
  requestDocoAccess: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
}));
vi.mock("~/lib/access-requests.server", () => ({
  requestDocoAccess: mocks.requestDocoAccess,
}));
vi.mock("../$docoHandle.search[.]json", () => ({ loader: mocks.searchLoader }));
vi.mock("../$docoHandle.api.$type[.]json", () => ({ action: mocks.captureAction }));
vi.mock("../$docoHandle.api.edges[.]json", () => ({ action: mocks.edgesAction }));

import { action, loader } from "../mcp";

const BEARER = { authorization: "Bearer doco_at_test" };

function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://doco.to/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: test reads loosely-typed JSON-RPC bodies.
type Json = any;

describe("POST /mcp (hosted remote MCP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_alice", username: "alice" });
  });

  it("401 + WWW-Authenticate at the protected-resource metadata when unauthenticated", async () => {
    mocks.getCurrentPrincipalAsync.mockResolvedValue(null);
    const res = await action({ request: rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://doco.to/.well-known/oauth-protected-resource"',
    );
  });

  it("initialize returns protocol version, serverInfo, and self-sufficient instructions", async () => {
    const res = await action({
      request: rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, BEARER),
    });
    const body: Json = await res.json();
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.serverInfo.name).toBe("doco");
    expect(body.result.instructions).toContain("doco_capture");
  });

  it("tools/list advertises read + write tools (search, capture, relate)", async () => {
    const res = await action({
      request: rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, BEARER),
    });
    const body: Json = await res.json();
    expect(body.result.tools.map((t: Json) => t.name)).toEqual([
      "doco_search",
      "doco_capture",
      "doco_relate",
      "doco_request_access",
    ]);
  });

  it("ping returns an empty result", async () => {
    const res = await action({ request: rpc({ jsonrpc: "2.0", id: 3, method: "ping" }, BEARER) });
    expect((await res.json()).result).toEqual({});
  });

  it("doco_search delegates to the search loader, replaying the bearer", async () => {
    mocks.searchLoader.mockResolvedValue(
      Response.json({ query: "auth", count: 1, hits: [{ id: "decision_1" }] }),
    );
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "doco_search",
            arguments: { query: "auth", doco: "torre-bpms", limit: 5 },
          },
        },
        BEARER,
      ),
    });
    const body: Json = await res.json();
    const callArg: Json = mocks.searchLoader.mock.calls[0][0];
    expect(callArg.params).toEqual({ docoHandle: "torre-bpms" });
    expect(callArg.request.headers.get("authorization")).toBe("Bearer doco_at_test");
    expect(callArg.request.url).toContain("/torre-bpms/search.json?q=auth");
    expect(callArg.request.url).toContain("limit=5");
    expect(body.result.structuredContent.count).toBe(1);
  });

  it("doco_capture normalizes a singular type to the plural route and delegates the POST", async () => {
    mocks.captureAction.mockResolvedValue(
      Response.json({ ok: true, id: "decision_1" }, { status: 201 }),
    );
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "doco_capture",
            arguments: {
              doco: "acme",
              type: "decision",
              body: { decision: "Use X", question: "X or Y?" },
            },
          },
        },
        BEARER,
      ),
    });
    const body: Json = await res.json();
    const callArg: Json = mocks.captureAction.mock.calls[0][0];
    // The per-type routes are keyed by the PLURAL type (/acme/api/decisions.json,
    // …/decisions.txt); singular input is normalized so agents can use either.
    expect(callArg.params).toEqual({ docoHandle: "acme", type: "decisions" });
    expect(callArg.request.method).toBe("POST");
    expect(callArg.request.headers.get("authorization")).toBe("Bearer doco_at_test");
    expect(callArg.request.url).toContain("/acme/api/decisions.json");
    expect(await callArg.request.json()).toEqual({ decision: "Use X", question: "X or Y?" });
    expect(body.result.structuredContent.id).toBe("decision_1");
  });

  it("doco_capture passes an already-plural type through unchanged", async () => {
    mocks.captureAction.mockResolvedValue(
      Response.json({ ok: true, id: "rule_1" }, { status: 201 }),
    );
    await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 14,
          method: "tools/call",
          params: {
            name: "doco_capture",
            arguments: { doco: "acme", type: "rules", body: { rule: "x" } },
          },
        },
        BEARER,
      ),
    });
    expect(mocks.captureAction.mock.calls[0][0].params).toEqual({
      docoHandle: "acme",
      type: "rules",
    });
  });

  it("doco_relate delegates a POST to the edges route with the edge body", async () => {
    mocks.edgesAction.mockResolvedValue(Response.json({ ok: true, id: "edge_1" }, { status: 201 }));
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "doco_relate",
            arguments: {
              doco: "acme",
              edge_type: "supports",
              from_id: "decision_1",
              to_id: "intent_1",
            },
          },
        },
        BEARER,
      ),
    });
    const body: Json = await res.json();
    const callArg: Json = mocks.edgesAction.mock.calls[0][0];
    expect(callArg.params).toEqual({ docoHandle: "acme" });
    expect(callArg.request.method).toBe("POST");
    expect(await callArg.request.json()).toEqual({
      edge_type: "supports",
      from_id: "decision_1",
      to_id: "intent_1",
    });
    expect(body.result.structuredContent.id).toBe("edge_1");
  });

  it("doco_request_access asks an owner for a grant via the access-requests lib", async () => {
    mocks.requestDocoAccess.mockResolvedValue({
      ok: true,
      alreadyHad: false,
      request: { id: "accreq_1", requested_role: "writer" },
      docoHandle: "acme",
    });
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "tools/call",
          params: {
            name: "doco_request_access",
            arguments: { doco: "acme", role: "writer", reason: "ship" },
          },
        },
        BEARER,
      ),
    });
    const body: Json = await res.json();
    expect(mocks.requestDocoAccess).toHaveBeenCalledWith({
      docoHandleOrId: "acme",
      requesterId: "user_alice",
      requestedRole: "writer",
      reason: "ship",
    });
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0].text).toContain("Requested writer");
    expect(body.result.structuredContent.id).toBe("accreq_1");
  });

  it("doco_request_access validates the requested role", async () => {
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 13,
          method: "tools/call",
          params: { name: "doco_request_access", arguments: { doco: "acme", role: "superuser" } },
        },
        BEARER,
      ),
    });
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(mocks.requestDocoAccess).not.toHaveBeenCalled();
  });

  it("doco_capture surfaces a write-denial as a clean tool error (grant change, not re-auth)", async () => {
    mocks.captureAction.mockResolvedValue(
      Response.json({ error: "not authorized" }, { status: 403 }),
    );
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: {
            name: "doco_capture",
            arguments: { doco: "acme", type: "decision", body: { decision: "x", question: "y" } },
          },
        },
        BEARER,
      ),
    });
    expect(res.status).toBe(200);
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("isn't granted");
  });

  it("doco_search requires a doco handle", async () => {
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "doco_search", arguments: { query: "x" } },
        },
        BEARER,
      ),
    });
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(mocks.searchLoader).not.toHaveBeenCalled();
  });

  it("surfaces a search-route access-denied (403) as a clean tool error, not a transport status", async () => {
    mocks.searchLoader.mockRejectedValue(
      new Response(JSON.stringify({ kind: "access_denied" }), { status: 403 }),
    );
    const res = await action({
      request: rpc(
        {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "doco_search", arguments: { query: "x", doco: "torre-bpms" } },
        },
        BEARER,
      ),
    });
    expect(res.status).toBe(200);
    const body: Json = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("isn't granted");
  });

  it("tools/call with an unknown tool errors (-32602)", async () => {
    const res = await action({
      request: rpc(
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } },
        BEARER,
      ),
    });
    expect((await res.json()).error.code).toBe(-32602);
  });

  it("unknown method returns -32601", async () => {
    const res = await action({
      request: rpc({ jsonrpc: "2.0", id: 7, method: "frobnicate" }, BEARER),
    });
    expect((await res.json()).error.code).toBe(-32601);
  });

  it("a notification (no id) gets 202 and no body", async () => {
    const res = await action({
      request: rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, BEARER),
    });
    expect(res.status).toBe(202);
  });

  it("GET is 405 — no SSE server stream", () => {
    expect(loader().status).toBe(405);
  });
});
