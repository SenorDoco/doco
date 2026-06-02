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
// Tools: doco_search (read), doco_capture + doco_relate (write) — each
// delegates to the matching per-doco REST route with the caller's bearer
// replayed, so the route's own per-type grant checks gate access (read vs
// write is a matrix grant, never a different login) — and doco_request_access,
// which asks an owner for a grant so a denied call works on the next try with
// no re-auth.

import { requestDocoAccess } from "~/lib/access-requests.server";
import { loadAgentIdentity } from "~/lib/agent-identity.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";
import { action as captureAction } from "./$docoHandle.api.$type[.]json";
import { action as changesetsAction } from "./$docoHandle.api.changesets[.]json";
import { action as edgesAction } from "./$docoHandle.api.edges[.]json";
import { loader as searchLoader } from "./$docoHandle.search[.]json";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "doco";
const SERVER_VERSION = "0.6.0-remote";

// Self-sufficient instructions: in a connector context there is no repo
// AGENTS.md, so the essentials ride here. Full protocol is linked.
const SERVER_INSTRUCTIONS = [
  "This project is tracked in a Doco — institutional memory of decisions,",
  "rules, intents, actions, and history. Call doco_whoami to see which",
  "Workspaces and Docos this token can reach — access is granted per-Workspace",
  "(covers all its Docos — common for an invited agent) or per-Doco, and whoami",
  "lists both (find a project's Doco handle without guessing). Call doco_search",
  "before answering substantive questions about how the project does things;",
  "there is almost",
  "always prior art you'd otherwise miss. Use doco_capture to record",
  "decisions/rules/etc. as they form and doco_relate to link them — or",
  "doco_changeset to create and wire many nodes in one atomic batch (the",
  "efficient way to import a process or backfill history). Use doco_get to",
  "read the authoring contract, policies, status, or a node by id. If a",
  "write is denied, your token has read but not write on that Doco — call",
  "doco_request_access to ask an owner for writer; once they approve your",
  "same token works on the next call (a grant change, no re-auth).",
  "Remote MCP auth is the client connector's job: do not hand-drive OAuth.",
  "Do not ask the user to paste localhost callback URLs back into chat.",
  "If the callback listener fails, restart the client MCP auth flow; use",
  "the direct device-flow recipe only outside remote MCP. Full",
  "protocol at /protocol/canonical-instructions.",
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

const CAPTURE_TOOL = {
  name: "doco_capture",
  description: [
    "Capture a node in a Doco — a decision, intent, action, rule, log, eval,",
    "reference, state, or idea. Records the institutional 'why' as it forms.",
    "Needs write access (writer role, or a per-type write grant). Read the",
    "type's body shape at /<doco>/api/<type>.txt first.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      doco: { type: "string", description: "Handle of the Doco to write to." },
      type: {
        type: "string",
        description:
          "Node type (plural): decisions | intents | actions | rules | logs | evals | references | states | ideas. Singular is accepted too.",
      },
      body: {
        type: "object",
        description:
          "Type-specific capture body (e.g. a decision: { decision, question }). See /<doco>/api/<type>.txt.",
        additionalProperties: true,
      },
    },
    required: ["doco", "type", "body"],
  },
};

const RELATE_TOOL = {
  name: "doco_relate",
  description: [
    "Create a first-class edge between two nodes in a Doco (e.g. supports,",
    "constrained_by, attributed_to, derived_from, flows_to, relates_to).",
    "Needs write access to the edge type.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      doco: { type: "string", description: "Handle of the Doco." },
      edge_type: {
        type: "string",
        description: "Edge type, e.g. supports | constrained_by | attributed_to | flows_to.",
      },
      from_id: { type: "string", description: "Source node id." },
      to_id: { type: "string", description: "Target node id." },
      props: {
        type: "object",
        description: "Optional edge props (e.g. role metadata).",
        additionalProperties: true,
      },
    },
    required: ["doco", "edge_type", "from_id", "to_id"],
  },
};

const REQUEST_ACCESS_TOOL = {
  name: "doco_request_access",
  description: [
    "Request access to a Doco you can't (fully) use yet. An owner approves and",
    "your EXISTING token gains the access on the next call — no re-auth. Use",
    "this when doco_search/doco_capture is denied, or to step up reader→writer.",
    "(Owners often instead invite you to the whole Workspace in the web app,",
    "which covers all its Docos at once — doco_whoami shows what you already have.)",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      doco: { type: "string", description: "Handle of the Doco to request access to." },
      role: {
        type: "string",
        description: "Role to request: reader | writer | owner.",
      },
      reason: {
        type: "string",
        description: "Optional note to the owner explaining why you need it.",
      },
    },
    required: ["doco", "role"],
  },
};

const GET_TOOL = {
  name: "doco_get",
  description: [
    "Read any document from a Doco's HTTP API by path — the read surface",
    "beyond doco_search. Use it for the authoring contract, capture policies,",
    "a node by id, a type listing, freshness/status, audit, or settings.",
    "Read-only (needs read access). Common `resource` values:",
    "  status.json                  — node counts + freshness (root path)",
    "  api/authoring-contract.json   — node/edge types + changeset op shapes",
    "  api/policies.json             — capture policies",
    "  api/decisions.json            — list a type (any plural type)",
    "  api/decisions/<id>.json       — one node by id",
    "  api/audit.json | api/settings.json",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      doco: { type: "string", description: "Handle of the Doco to read from." },
      resource: {
        type: "string",
        description:
          "Path under the Doco: 'status.json' or an 'api/…' path (e.g. 'api/policies.json', 'api/decisions/<id>.json').",
      },
    },
    required: ["doco", "resource"],
  },
};

const CHANGESET_TOOL = {
  name: "doco_changeset",
  description: [
    "Apply a batch of graph-authoring operations to a Doco in ONE atomic",
    "request — create nodes, relate them with typed edges, append steps.",
    "The efficient way to author many nodes/edges at once (e.g. importing a",
    "process or backfilling history): one call instead of dozens of",
    "doco_capture/doco_relate calls. Up to 50 operations. Reference an",
    'earlier create\'s `alias` as "$alias" in a later op. Read',
    "/<doco>/api/authoring-contract.json for operation shapes and relation",
    "kinds. Needs write access to each type touched (same grant model as",
    "doco_capture).",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      doco: { type: "string", description: "Handle of the Doco to write to." },
      operations: {
        type: "array",
        description:
          "Ordered ops: {op:'create',entity_type,alias?,body} | {op:'relate',relation_kind,from,to} | {op:'relate_many',relations:[…]} | {op:'append',entity_type,after,relation_kind,body}.",
        items: { type: "object", additionalProperties: true },
      },
      validate_against: {
        type: "string",
        description:
          "Optional perspective to check structural integrity against (e.g. 'bpmn'); returns an integrity summary alongside the results.",
      },
    },
    required: ["doco", "operations"],
  },
};

const WHOAMI_TOOL = {
  name: "doco_whoami",
  description: [
    "Identity + reach for the current credential: who you're acting as, and",
    "which Workspaces and Docos this token can reach, with your role in each.",
    "Access comes at two levels: a WORKSPACE grant (covers every Doco in it —",
    "the common case for an invited agent) or a single DOCO. This lists both,",
    "with the Docos inside a reachable Workspace included.",
    "Call this FIRST to orient — it's how you find a project's Doco handle",
    "(the <handle> in /<handle>) without guessing, and which Workspace to",
    "create a new Doco in. No arguments.",
  ].join("\n"),
  inputSchema: { type: "object", properties: {} },
};

const TOOLS = [
  WHOAMI_TOOL,
  SEARCH_TOOL,
  GET_TOOL,
  CAPTURE_TOOL,
  RELATE_TOOL,
  CHANGESET_TOOL,
  REQUEST_ACCESS_TOOL,
];

type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
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

function toolError(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

async function safeJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return {};
  }
}

// A route denial becomes a clean JSON-RPC tool error — never a raw
// transport status a connector might misread as an auth failure. A missing
// write grant is an authorization problem: ask an owner to grant it (a
// matrix change), not re-authenticate.
function delegateError(verb: string, doco: string, status: number, data: unknown): ToolResult {
  if (status === 401 || status === 403) {
    return toolError(
      `Not authorized to ${verb} "${doco}". This token isn't granted that access — ask an owner to grant it (reader to read, writer or the per-type grant to write). It's a grant change, no re-auth.`,
    );
  }
  if (status === 404) return toolError(`Doco "${doco}" not found. Check the handle.`);
  const detail =
    data && typeof data === "object" && "error" in (data as Record<string, unknown>)
      ? ` ${String((data as Record<string, unknown>).error)}`
      : "";
  return toolError(`doco ${verb} failed for "${doco}" (status ${status}).${detail}`);
}

function bearerHeaders(request: Request, extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  const auth = request.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  return headers;
}

// Delegate a tool to the matching per-doco route handler, replaying the
// caller's bearer so the route's own auth + per-type grant checks gate
// access. The route either THROWS a Response (no read access) or RETURNS a
// non-ok Response (write denied, bad body); both become clean tool errors.
async function delegate(
  verb: string,
  doco: string,
  call: () => Promise<unknown>,
): Promise<ToolResult> {
  let res: Response;
  try {
    res = (await call()) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) {
      return delegateError(verb, doco, thrown.status, await safeJson(thrown));
    }
    throw thrown;
  }
  const data = await safeJson(res);
  if (!res.ok) return delegateError(verb, doco, res.status, data);
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

async function runDocoSearch(request: Request, args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  const doco = String(args.doco ?? "").trim();
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
  if (!doco) return toolError("doco_search requires a `doco` handle.");
  const origin = new URL(request.url).origin;
  const url = `${origin}/${encodeURIComponent(doco)}/search.json?q=${encodeURIComponent(query)}&limit=${limit}`;
  const req = new Request(url, { headers: bearerHeaders(request) });
  return delegate("search", doco, () =>
    searchLoader({ request: req, params: { docoHandle: doco } as never }),
  );
}

async function runDocoCapture(
  request: Request,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const doco = String(args.doco ?? "").trim();
  // The per-type capture routes are keyed by the PLURAL type
  // (/<doco>/api/decisions.json, …/decisions.txt). Accept singular or plural
  // from the caller and normalize, so doco_capture works either way.
  const rawType = String(args.type ?? "")
    .trim()
    .toLowerCase();
  const type = rawType && !rawType.endsWith("s") ? `${rawType}s` : rawType;
  const body = args.body;
  if (!doco || !type) return toolError("doco_capture requires `doco` and `type`.");
  if (!body || typeof body !== "object") {
    return toolError(
      "doco_capture requires a `body` object — see /<doco>/api/<type>.txt for the shape.",
    );
  }
  const origin = new URL(request.url).origin;
  const url = `${origin}/${encodeURIComponent(doco)}/api/${encodeURIComponent(type)}.json`;
  const req = new Request(url, {
    method: "POST",
    headers: bearerHeaders(request, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return delegate("write to", doco, () =>
    captureAction({ request: req, params: { docoHandle: doco, type } as never }),
  );
}

async function runDocoRelate(request: Request, args: Record<string, unknown>): Promise<ToolResult> {
  const doco = String(args.doco ?? "").trim();
  const edgeType = String(args.edge_type ?? "").trim();
  const fromId = String(args.from_id ?? "").trim();
  const toId = String(args.to_id ?? "").trim();
  if (!doco || !edgeType || !fromId || !toId) {
    return toolError("doco_relate requires `doco`, `edge_type`, `from_id`, and `to_id`.");
  }
  const payload: Record<string, unknown> = { edge_type: edgeType, from_id: fromId, to_id: toId };
  if (args.props && typeof args.props === "object") payload.props = args.props;
  const origin = new URL(request.url).origin;
  const url = `${origin}/${encodeURIComponent(doco)}/api/edges.json`;
  const req = new Request(url, {
    method: "POST",
    headers: bearerHeaders(request, { "content-type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return delegate("create edges in", doco, () =>
    edgesAction({ request: req, params: { docoHandle: doco } as never }),
  );
}

async function runDocoChangeset(
  request: Request,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const doco = String(args.doco ?? "").trim();
  const operations = args.operations;
  if (!doco) return toolError("doco_changeset requires a `doco` handle.");
  if (!Array.isArray(operations) || operations.length === 0) {
    return toolError(
      "doco_changeset requires a non-empty `operations` array. See /<doco>/api/authoring-contract.json for operation shapes.",
    );
  }
  const payload: Record<string, unknown> = { operations };
  if (typeof args.validate_against === "string" && args.validate_against.trim()) {
    payload.validate_against = args.validate_against.trim();
  }
  const origin = new URL(request.url).origin;
  const url = `${origin}/${encodeURIComponent(doco)}/api/changesets.json`;
  const req = new Request(url, {
    method: "POST",
    headers: bearerHeaders(request, { "content-type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return delegate("apply a changeset to", doco, () =>
    changesetsAction({ request: req, params: { docoHandle: doco } as never }),
  );
}

// doco_get is the generic read surface: it GETs any document under the Doco's
// HTTP API (or the root /status.json) with the caller's bearer replayed, so
// the target route's own read gate applies. Unlike the write tools it can't
// import a single route handler — node-by-id lives at a route per type — so it
// fetches the same origin and lets routing dispatch. The path is constrained
// to the Doco's own read namespace (no traversal, no absolute URLs).
async function runDocoGet(request: Request, args: Record<string, unknown>): Promise<ToolResult> {
  const doco = String(args.doco ?? "").trim();
  const resource = String(args.resource ?? "")
    .trim()
    .replace(/^\/+/, "");
  if (!doco) return toolError("doco_get requires a `doco` handle.");
  if (!resource) {
    return toolError(
      "doco_get requires a `resource` path, e.g. 'status.json' or 'api/authoring-contract.json'.",
    );
  }
  if (resource.includes("..") || resource.includes("://")) {
    return toolError("doco_get `resource` must be a path within the Doco (no '..' or URLs).");
  }
  if (resource !== "status.json" && !resource.startsWith("api/")) {
    return toolError(
      "doco_get `resource` must be 'status.json' or an 'api/…' path (e.g. 'api/policies.json').",
    );
  }
  const origin = new URL(request.url).origin;
  const url = `${origin}/${encodeURIComponent(doco)}/${resource}`;
  return delegate("read from", doco, () => fetch(url, { headers: bearerHeaders(request) }));
}

// doco_whoami: identity + reachable Workspaces/Docos for the calling token.
// loadAgentIdentity intersects the principal's grants with the token's scope;
// a defer-to-matrix ("*") token reaches everything the principal can, so the
// grants list IS the discovery surface (no separate workspaces/docos call).
async function runDocoWhoami(request: Request): Promise<ToolResult> {
  const identity = await loadAgentIdentity(request);
  if (!identity) return toolError("Not authenticated.");
  const grants = identity.grants ?? [];
  // Surface the two access levels distinctly: a Workspace grant (covers every
  // Doco in it — the common case for an invited agent) vs a single Doco.
  const workspaces = grants.filter((g) => g.scope === "workspace");
  const docos = grants.filter((g) => g.scope === "doco");
  const lines: string[] = [`Authenticated as ${identity.indicator_prefix}.`];
  if (workspaces.length > 0) {
    lines.push(
      "Workspaces you can reach (a Workspace grant covers all its Docos, and lets you create new ones in it):",
    );
    for (const w of workspaces) lines.push(`  • ${w.label} (workspace): ${w.role}`);
  }
  if (docos.length > 0) {
    lines.push("Docos you can reach (the <handle> in /<handle>):");
    for (const d of docos) lines.push(`  • ${d.label}: ${d.role}`);
  }
  if (workspaces.length === 0 && docos.length === 0) {
    lines.push(
      "Nothing reachable yet — an owner usually invites you to a Workspace (covering all its Docos), or use doco_request_access for a specific Doco.",
    );
  }
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: identity };
}

// Not a delegate: requesting access is a first-party action (no per-doco REST
// route), so it calls the access-requests lib directly with the token's
// principal as the requester.
async function runDocoRequestAccess(
  args: Record<string, unknown>,
  requesterId: string,
): Promise<ToolResult> {
  const doco = String(args.doco ?? "").trim();
  const role = String(args.role ?? "")
    .trim()
    .toLowerCase();
  const reason = args.reason == null ? null : String(args.reason);
  if (!doco) return toolError("doco_request_access requires a `doco` handle.");
  if (role !== "reader" && role !== "writer" && role !== "owner") {
    return toolError("doco_request_access `role` must be reader, writer, or owner.");
  }
  const result = await requestDocoAccess({
    docoHandleOrId: doco,
    requesterId,
    requestedRole: role,
    reason,
  });
  if (!result.ok) return toolError(result.error);
  if (result.alreadyHad) {
    return {
      content: [
        {
          type: "text",
          text: `You already have ${result.role} on "${result.docoHandle}" — nothing to request.`,
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `Requested ${result.request.requested_role} on "${result.docoHandle}". An owner will see it in their access-requests inbox; once approved, your existing token works on the next call — no reconnect. (Request ${result.request.id}.)`,
      },
    ],
    structuredContent: result.request,
  };
}

async function dispatch(message: Rpc, request: Request, principalId: string): Promise<Response> {
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
      const params = message.params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined;
      const name = params?.name;
      const args = params?.arguments ?? {};
      switch (name) {
        case "doco_whoami":
          return rpcResult(message.id, await runDocoWhoami(request));
        case "doco_search":
          return rpcResult(message.id, await runDocoSearch(request, args));
        case "doco_get":
          return rpcResult(message.id, await runDocoGet(request, args));
        case "doco_capture":
          return rpcResult(message.id, await runDocoCapture(request, args));
        case "doco_relate":
          return rpcResult(message.id, await runDocoRelate(request, args));
        case "doco_changeset":
          return rpcResult(message.id, await runDocoChangeset(request, args));
        case "doco_request_access":
          return rpcResult(message.id, await runDocoRequestAccess(args, principalId));
        default:
          return rpcError(message.id, -32602, `Unknown tool: ${name}`);
      }
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
  return dispatch(message, request, principal.id);
}
