// POST /mcp — hosted remote MCP endpoint (Streamable HTTP, JSON-RPC 2.0).
//
// The connector flavor of the bundled stdio server
// (.agents/doco-mcp-server.mjs): the same MCP protocol, but auth moves
// into the transport. The caller presents an OAuth 2.1 bearer token
// (`Authorization: Bearer doco_at_…`); there are no auth tools to call.
// An unauthenticated request gets 401 + WWW-Authenticate pointing at the
// RFC 9728 protected-resource metadata, which a connector follows to
// discover the OAuth server (RFC 8414) and run the flow.
//
// v1 exposes doco_search scoped to one Doco (an explicit `doco` handle),
// reusing the per-doco search route's auth + ranking. Cross-doco
// "search everything I can read" is a planned follow-up.

import { getCurrentPrincipalAsync } from "~/lib/session.server";
import { loader as searchLoader } from "./$docoHandle.search[.]json";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "doco";
const SERVER_VERSION = "0.3.0-remote";

// Self-sufficient instructions: in a connector context there is no repo
// AGENTS.md, so the essentials ride here. Full protocol is linked.
const SERVER_INSTRUCTIONS = [
  "This project is tracked in a Doco — institutional memory of decisions,",
  "rules, intents, actions, and history. Call doco_search before answering",
  "substantive questions about how the project does things; there is almost",
  "always prior art you'd otherwise miss. Full protocol at",
  "/protocol/canonical-instructions.",
].join("\n");

const SEARCH_TOOL = {
  name: "doco_search",
  description: [
    "Search a Doco (institutional memory of decisions, rules, intents,",
    "actions, and history). Returns ranked nodes by vector similarity.",
    "Call this before answering substantive questions about the project.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text query. Vector search; phrasing flexible." },
      doco: { type: "string", description: "Handle of the Doco to search." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 10,
        description: "Maximum hits to return (default 10, max 50).",
      },
    },
    required: ["query", "doco"],
  },
};

const TOOLS = [SEARCH_TOOL];

type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function rpcResult(id: Rpc["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: Rpc["id"], code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

function unauthorized(request: Request): Response {
  const origin = new URL(request.url).origin;
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

// Delegate doco_search to the per-doco search route loader, replaying the
// caller's bearer so its own auth (enforceOauthGrant) gates access.
async function runDocoSearch(
  request: Request,
  args: Record<string, unknown>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}> {
  const query = String(args.query ?? "").trim();
  const doco = String(args.doco ?? "").trim();
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
  if (!doco) {
    return {
      isError: true,
      content: [{ type: "text", text: "doco_search requires a `doco` handle." }],
    };
  }
  const origin = new URL(request.url).origin;
  const searchUrl = `${origin}/${encodeURIComponent(doco)}/search.json?q=${encodeURIComponent(query)}&limit=${limit}`;
  const headers = new Headers();
  const auth = request.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  const searchReq = new Request(searchUrl, { headers });
  const res = await searchLoader({ request: searchReq, params: { docoHandle: doco } as never });
  const data = await (res as Response).json();
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

async function dispatch(message: Rpc, request: Request): Promise<Response> {
  switch (message.method) {
    case "initialize":
      return rpcResult(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      });
    case "ping":
      return rpcResult(message.id, {});
    case "tools/list":
      return rpcResult(message.id, { tools: TOOLS });
    case "tools/call": {
      const name = (message.params as { name?: string } | undefined)?.name;
      if (name !== "doco_search") return rpcError(message.id, -32602, `Unknown tool: ${name}`);
      const args =
        (message.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {};
      return rpcResult(message.id, await runDocoSearch(request, args));
    }
    case "resources/list":
      return rpcResult(message.id, { resources: [] });
    case "prompts/list":
      return rpcResult(message.id, { prompts: [] });
    default:
      return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

// GET (SSE server→client stream) is not supported by this stateless
// request/response server; the spec permits a 405 here.
export function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

export async function action({ request }: { request: Request }): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const principal = await getCurrentPrincipalAsync(request);
  if (!principal) return unauthorized(request);

  let message: Rpc;
  try {
    message = (await request.json()) as Rpc;
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (message.jsonrpc !== "2.0")
    return rpcError(message.id ?? null, -32600, "Invalid Request", 400);
  // Notifications (no id) expect no response body.
  if (message.id === undefined) return new Response(null, { status: 202 });
  return dispatch(message, request);
}
