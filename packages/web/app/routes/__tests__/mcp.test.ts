import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipalAsync: vi.fn(),
  searchLoader: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
}));

vi.mock("../$docoHandle.search[.]json", () => ({
  loader: mocks.searchLoader,
}));

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
    expect(body.result.instructions).toContain("doco_search");
  });

  it("tools/list advertises only doco_search (auth tools drop in the connector flavor)", async () => {
    const res = await action({
      request: rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, BEARER),
    });
    const body: Json = await res.json();
    expect(body.result.tools.map((t: Json) => t.name)).toEqual(["doco_search"]);
  });

  it("ping returns an empty result", async () => {
    const res = await action({ request: rpc({ jsonrpc: "2.0", id: 3, method: "ping" }, BEARER) });
    expect((await res.json()).result).toEqual({});
  });

  it("tools/call doco_search delegates to the per-doco search loader, replaying the bearer", async () => {
    mocks.searchLoader.mockResolvedValue(
      Response.json({
        query: "auth",
        count: 1,
        hits: [{ id: "decision_1" }],
        viewer: { username: "alice" },
      }),
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
    expect(mocks.searchLoader).toHaveBeenCalledTimes(1);
    const callArg: Json = mocks.searchLoader.mock.calls[0][0];
    expect(callArg.params).toEqual({ docoHandle: "torre-bpms" });
    expect(callArg.request.headers.get("authorization")).toBe("Bearer doco_at_test");
    expect(callArg.request.url).toContain("/torre-bpms/search.json?q=auth");
    expect(callArg.request.url).toContain("limit=5");
    expect(body.result.structuredContent.count).toBe(1);
  });

  it("tools/call requires a doco handle", async () => {
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
    expect(body.result.content[0].text).toContain("isn't granted access");
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
