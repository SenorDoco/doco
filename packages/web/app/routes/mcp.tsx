// POST /mcp — Model Context Protocol (Streamable HTTP transport).
//
// The Doco MCP server. Once an agent runtime (Claude Code, Claude
// Desktop, Cursor, etc.) installs this URL as an MCP server, the
// agent gains native Doco tools: bootstrap, search, capture_decision,
// capture_rule. No more raw curl, no more credential-in-shell-history,
// no more "remind me which endpoint accepts which field" friction.
//
// Authentication: the MCP client passes `Authorization: Bearer
// ${DOCO_ACCESS}` (per the Streamable HTTP spec). The token resolves
// to a Doco + Principal via the existing TokenStore, and tools fan
// out to the same internal entry points the JSON routes use.
//
// Protocol shape (minimal — just enough to be a useful client):
//   - initialize           — handshake; advertise serverInfo + capabilities
//   - notifications/initialized — one-way client ack (no response)
//   - tools/list           — return the tool definitions
//   - tools/call           — invoke a tool, return content[]
//
// Future work (not in this MVP):
//   - SSE streaming for long-running tool calls (currently single JSON response)
//   - resources/list + resources/read (no per-Doco resources exposed yet)
//   - prompts/list (the onboarding-overlay text is a natural fit)
//   - logging/setLevel (server-side debug toggles)
//
// All four shipped tools delegate to existing internal capture/search
// functions rather than re-deriving logic; the route is a thin
// protocol adapter, not a parallel implementation.

import type { EntityId } from "@doco/shared";
import { getDocoById } from "@doco/db";
import { docoPath, rootDir } from "~/lib/db.server";
import { normalizeDocoParams } from "~/lib/doco-access.server";
import {
  type DecisionDraft,
  captureDecision,
} from "~/lib/capture.server";
import { loadBootstrapContext } from "~/lib/bootstrap-context.server";
import { CANONICAL_INSTRUCTIONS } from "~/lib/instructions.server";
import { extractCredential } from "~/lib/session";
import { TokenStore } from "~/lib/tokens.server";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 plumbing.
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

// Application-level errors (MCP convention reserves -32000..-32099).
const MCP_AUTH_REQUIRED = -32001;
const MCP_TOOL_FAILED = -32002;

function rpcOk(id: JsonRpcId, result: unknown): Response {
  const body: JsonRpcSuccess = { jsonrpc: "2.0", id, result };
  return Response.json(body);
}

function rpcErr(id: JsonRpcId, code: number, message: string, data?: unknown): Response {
  const body: JsonRpcError = {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
  return Response.json(body);
}

// ---------------------------------------------------------------------------
// Authentication.
// ---------------------------------------------------------------------------

interface ResolvedSession {
  agentId: EntityId<"principal">;
  docoId: EntityId<"doco">;
  docoHandle: string;
  ownerSlug: string;
  docoDir: string;
  /** The raw bearer the MCP client sent — passed through to internal
   *  HTTP proxies (search) so they hit the same access-control path
   *  as any other authenticated request. */
  rawCredential: string;
}

async function resolveSession(request: Request): Promise<ResolvedSession | null> {
  const credential = extractCredential(request);
  if (!credential) return null;
  const session = await TokenStore.forDoco(rootDir()).resolve(credential);
  if (!session || !session.bound_doco_id) return null;
  const doco = await getDocoById(session.bound_doco_id);
  if (!doco) return null;
  const norm = await normalizeDocoParams({ docoId: doco.id });
  return {
    agentId: session.principal_id as EntityId<"principal">,
    docoId: doco.id as EntityId<"doco">,
    docoHandle: doco.handle,
    ownerSlug: norm.ownerSlug,
    docoDir: docoPath(doco.handle),
    rawCredential: credential,
  };
}

// ---------------------------------------------------------------------------
// Tool registry.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "bootstrap",
    description:
      "Fetch the current canonical_instructions + per-Doco context (scopes, constitution, onboarding_overlay). Call this once per session before drafting any capture or reply.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search",
    description:
      "Search the connected Doco for prior decisions, rules, intents, actions, or logs matching a query. Use BEFORE drafting any new node to avoid duplicates.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Free-text query (paraphrase what you'd capture)." },
        limit: {
          type: "number",
          description: "Max hits (default 10, max 50).",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
  {
    name: "list_scopes",
    description:
      "Return the connected Doco's live scope manifest (id, name, summary, icon, allowed_node_types, node_count). Use this to pick the right scope for a capture.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "capture_decision",
    description:
      "Capture a Decision node — a one-time choice with alternatives considered. Posts to the Doco's decisions API.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question the Decision answers." },
        chosen: { type: "string", description: "The chosen resolution (multi-line OK)." },
        scope_names: {
          type: "array",
          items: { type: "string" },
          description:
            "At least one scope name (hashtag-shaped, e.g. '#important' or '#adrs'). File on the scope whose allowed_node_types accepts 'decision'.",
        },
        summary: { type: "string", description: "Optional one-line summary." },
        alternatives: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              rejected_because: { type: "string" },
            },
            required: ["name", "rejected_because"],
          },
          description: "Optional rejected alternatives.",
        },
        body_md: { type: "string", description: "Optional raw markdown appended after frontmatter." },
      },
      required: ["question", "chosen", "scope_names"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations.
// ---------------------------------------------------------------------------

async function tool_bootstrap(session: ResolvedSession): Promise<unknown> {
  const ctx = await loadBootstrapContext({
    docoDir: session.docoDir,
    docoId: session.docoId,
    handle: session.docoHandle,
    baseUrl: "https://doco.to",
  });
  return {
    canonical_instructions: CANONICAL_INSTRUCTIONS,
    doco_id: session.docoId,
    doco_handle: session.docoHandle,
    scopes: ctx.scopes,
    constitution: ctx.constitution,
    onboarding_overlay: ctx.onboarding_overlay,
  };
}

async function tool_search(
  session: ResolvedSession,
  args: { q?: unknown; limit?: unknown },
): Promise<unknown> {
  const q = typeof args.q === "string" ? args.q.trim() : "";
  if (!q) throw new Error("search.q is required");
  const limit =
    typeof args.limit === "number" && args.limit > 0 && args.limit <= 50 ? args.limit : 10;
  // Search lives behind the per-Doco /search.json route — proxy via an
  // internal HTTPS fetch so we inherit the same ranking + access
  // control. The agent's own bearer is reused, so the proxied call
  // resolves to the same Principal + Doco.
  // NOTE: V1 uses an internal HTTPS roundtrip. Cheap to swap for a
  // direct function call once the search internals expose a stable
  // server-side entry point.
  const url = `https://doco.to/${session.docoHandle}/search.json?q=${encodeURIComponent(q)}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${session.rawCredential}`,
    },
  });
  if (!res.ok) {
    throw new Error(`search failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

async function tool_list_scopes(session: ResolvedSession): Promise<unknown> {
  const ctx = await loadBootstrapContext({
    docoDir: session.docoDir,
    docoId: session.docoId,
    handle: session.docoHandle,
    baseUrl: "https://doco.to",
  });
  // Filter to just live scopes (already filtered upstream) and project
  // the fields most useful for routing capture targets.
  return {
    scopes: ctx.scopes.map((s) => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      summary: s.summary,
      allowed_node_types: s.allowed_node_types,
      node_count: s.node_count ?? 0,
      is_watched: s.is_watched,
    })),
  };
}

async function tool_capture_decision(
  session: ResolvedSession,
  args: Record<string, unknown>,
): Promise<unknown> {
  const draft: DecisionDraft = {
    question: typeof args.question === "string" ? args.question : "",
    chosen: typeof args.chosen === "string" ? args.chosen : "",
    scope_names: Array.isArray(args.scope_names)
      ? (args.scope_names as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
  };
  if (typeof args.summary === "string") draft.summary = args.summary;
  if (typeof args.body_md === "string") draft.body_md = args.body_md;
  if (Array.isArray(args.alternatives)) {
    draft.alternatives = (args.alternatives as unknown[])
      .filter((v): v is { name: string; rejected_because: string } =>
        typeof v === "object" && v !== null &&
        typeof (v as Record<string, unknown>).name === "string" &&
        typeof (v as Record<string, unknown>).rejected_because === "string",
      );
  }
  if (!draft.question || !draft.chosen || draft.scope_names.length === 0) {
    throw new Error("capture_decision requires question, chosen, and at least one scope_name");
  }
  draft.decided_by_username = `mcp-agent-${session.agentId.slice(0, 8)}`;
  draft.created_by_id = session.agentId;
  const result = await captureDecision(
    session.docoDir,
    session.docoId,
    session.ownerSlug,
    session.docoHandle,
    draft,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Dispatcher.
// ---------------------------------------------------------------------------

async function callTool(
  session: ResolvedSession,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "bootstrap":
      return await tool_bootstrap(session);
    case "search":
      return await tool_search(session, args);
    case "list_scopes":
      return await tool_list_scopes(session);
    case "capture_decision":
      return await tool_capture_decision(session, args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function asContent(value: unknown): { content: { type: string; text: string }[] } {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Route entry points.
// ---------------------------------------------------------------------------

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return rpcErr(null, INVALID_REQUEST, "MCP transport requires POST");
  }

  let payload: JsonRpcRequest;
  try {
    payload = (await request.json()) as JsonRpcRequest;
  } catch (e) {
    return rpcErr(null, PARSE_ERROR, `parse error: ${(e as Error).message}`);
  }

  if (payload?.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return rpcErr(payload?.id ?? null, INVALID_REQUEST, "expected JSON-RPC 2.0 envelope");
  }

  const id = payload.id ?? null;
  const method = payload.method;
  const params = (payload.params ?? {}) as Record<string, unknown>;

  try {
    switch (method) {
      case "initialize": {
        // Advertise the server. Protocol version negotiation is
        // permissive — accept whatever the client offered.
        const clientProtocol =
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
        return rpcOk(id, {
          protocolVersion: clientProtocol,
          capabilities: { tools: {} },
          serverInfo: { name: "doco", version: "0.1.0" },
        });
      }
      case "notifications/initialized": {
        // Client one-way ack; per JSON-RPC convention notifications
        // get no response body, but we still must respond with 200 in
        // HTTP transport. Empty body.
        return new Response(null, { status: 204 });
      }
      case "tools/list": {
        return rpcOk(id, { tools: TOOLS });
      }
      case "tools/call": {
        const session = await resolveSession(request);
        if (!session) {
          return rpcErr(
            id,
            MCP_AUTH_REQUIRED,
            "Authorization required. Send `Authorization: Bearer ${DOCO_ACCESS}` per Streamable HTTP transport.",
          );
        }
        const toolName = typeof params.name === "string" ? params.name : "";
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
        if (!toolName) {
          return rpcErr(id, INVALID_REQUEST, "tools/call requires `name`");
        }
        try {
          const result = await callTool(session, toolName, toolArgs);
          return rpcOk(id, asContent(result));
        } catch (e) {
          return rpcErr(id, MCP_TOOL_FAILED, `${toolName} failed: ${(e as Error).message}`);
        }
      }
      default:
        return rpcErr(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  } catch (e) {
    return rpcErr(id, INTERNAL_ERROR, `internal error: ${(e as Error).message}`);
  }
}

export function loader() {
  return Response.json(
    {
      name: "doco",
      version: "0.1.0",
      transport: "streamable-http",
      protocol_versions_supported: ["2024-11-05"],
      auth: "Bearer ${DOCO_ACCESS} (header)",
      hint: "POST JSON-RPC 2.0 to this URL. See https://modelcontextprotocol.io/specification/draft/basic/transports#streamable-http",
    },
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}
