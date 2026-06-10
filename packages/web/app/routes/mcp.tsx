// POST /mcp — the hosted remote MCP endpoint (Streamable HTTP, JSON-RPC 2.0).
//
// One connection per user. The caller presents an OAuth 2.1 bearer
// (`Authorization: Bearer doco_at_…`) and the gate (gateUserMcp) reads the
// session's reach from the token, not the URL:
//   - an "act as me" (actor) token reaches EVERY workspace the user belongs to,
//     one Doco at a time — `list_workspaces` enumerates them and any Doco's
//     <handle> works with the tools regardless of which workspace it's in;
//   - a workspace-scoped token pins the session to its single workspace.
// Either way a tool call can only touch Docos the live grant allows.
//
// An unauthenticated request gets 401 + WWW-Authenticate pointing at the
// RFC 9728 protected-resource metadata at
// /.well-known/oauth-protected-resource/mcp, which a connector follows to
// discover the OAuth server (RFC 8414) and run the flow.

import { getDocoByIdOrHandle, getWorkspaceConstitutionsByIds } from "@doco/db";
import { requestDocoAccess } from "~/lib/access-requests.server";
import { gatherAgentDebug } from "~/lib/agent-debug.server";
import { loadAgentIdentity } from "~/lib/agent-identity.server";
import { isSuperadmin } from "~/lib/session.server";
import { gateUserMcp } from "~/lib/user-mcp.server";
import { resolveDocoInWorkspace } from "~/lib/workspace-mcp.server";
import { action as captureAction } from "./$docoHandle.api.$type[.]json";
import { action as changesetsAction } from "./$docoHandle.api.changesets[.]json";
import { action as edgesAction } from "./$docoHandle.api.edges[.]json";
import { action as policyIdAction } from "./$docoHandle.api.policies.$id[.]json";
import { action as policiesAction } from "./$docoHandle.api.policies[.]json";
import { loader as searchLoader } from "./$docoHandle.search[.]json";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "doco";
const SERVER_VERSION = "1.0.0-workspace";

// Self-sufficient instructions: in a connector context there is no repo
// AGENTS.md, so the essentials ride here. Full protocol is linked.
const SERVER_INSTRUCTIONS = [
  "This is Doco's hosted MCP server — institutional memory (decisions, rules,",
  "intents, actions, history) for the projects you work on. It connects once and",
  "acts as you, with whatever reach the user authorized — one workspace,",
  "several, or specific Docos. Use all of it: work across every workspace and",
  "Doco the grant covers, as the task needs; never cap yourself at one. Call",
  "doco_whoami FIRST to see who you're acting as, your reach, and the",
  "constitution(s) your captures must honor; list_workspaces enumerates the",
  "workspaces you can reach, and any reachable Doco's <handle> works with the",
  "tools regardless of workspace. A project may narrow this: if its checkout's",
  ".doco/connections.md declares a focus — one or more workspaces/Docos this",
  "project is about — work across exactly that set; with none declared the whole",
  "grant stands, and you never narrow on your own. Call doco_search before answering substantive questions about how",
  "a project does things; there is almost always prior art you'd otherwise miss.",
  "Use doco_capture to record decisions/rules/etc. as they form and doco_relate",
  "to link them — or doco_changeset to create and wire many nodes in one atomic",
  "batch (the efficient way to import a process or backfill history). Use",
  "doco_policy to write or modify a Doco's authoring policies (owner only). Use",
  "doco_get to read the authoring contract, policies, status, or a node by id. If a",
  "write is denied, your token has read but not write on that Doco — call",
  "doco_request_access to ask an owner for writer; once they approve your",
  "same token works on the next call (a grant change, no re-auth).",
  "To investigate a production incident (a stuck/failed Señor Doco turn, a",
  "missing attachment, a capture error), the host superadmin can call",
  "doco_agent_debug — it reads the deployed app's diagnostics (and analyzes",
  "why an attached file did or didn't reach the model); it denies everyone else.",
  "Remote MCP auth is the client connector's job: do not hand-drive OAuth.",
  "Do not ask the user to paste localhost callback URLs back into chat.",
  "If the callback listener fails, restart the client MCP auth flow; use",
  "the direct device-flow recipe only outside remote MCP. Full",
  "protocol at /protocol/canonical-instructions.",
].join("\n");

const SEARCH_TOOL = {
  name: "doco_search",
  description: [
    "Search a Doco in this workspace (institutional memory of decisions, rules,",
    "intents, actions, and history). Returns ranked nodes by vector similarity.",
    "Call this before answering substantive questions about the project.",
    "The result carries a `display` object with ready-to-paste protocol lines:",
    "emit `display.found` verbatim after the result, and end your turn with",
    "`display.tally` verbatim (bump its count if you also captured) — paste",
    "them, don't hand-format the indicator lines.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text query. Vector search; phrasing flexible." },
      doco: {
        type: "string",
        description: "Handle of the Doco to search (must be in this workspace).",
      },
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
    "The result's `footer_lines` are ready-to-paste protocol lines — emit each",
    "verbatim after the write, and count them toward your closing tally.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      doco: {
        type: "string",
        description: "Handle of the Doco to write to (must be in this workspace).",
      },
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
    "Needs write access to the edge type. Edges share the node lifecycle",
    "(drafting → queued → active → retired): an ACTIVE edge can only connect",
    "ACTIVE nodes. Omit `lifecycle` and the edge defaults to active when both",
    "endpoints are active, else drafting.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      doco: { type: "string", description: "Handle of the Doco (must be in this workspace)." },
      edge_type: {
        type: "string",
        description: "Edge type, e.g. supports | constrained_by | attributed_to | flows_to.",
      },
      from_id: { type: "string", description: "Source node id." },
      to_id: { type: "string", description: "Target node id." },
      label: {
        type: "string",
        description: "Optional flows_to branch label (BPMN sequence-flow label).",
      },
      condition: {
        type: "string",
        description: "Optional flows_to gateway condition.",
      },
      kind: {
        type: "string",
        description: 'Optional flows_to kind, e.g. "exception" or "timer".',
      },
      lifecycle: {
        type: "string",
        description:
          "Optional starting stage: drafting | queued | active. Omit to default (active iff both endpoints are active, else drafting). An explicit `active` to a non-active node is rejected.",
      },
    },
    required: ["doco", "edge_type", "from_id", "to_id"],
  },
};

const REQUEST_ACCESS_TOOL = {
  name: "doco_request_access",
  description: [
    "Request access to a Doco in this workspace you can't (fully) use yet. An",
    "owner approves and your EXISTING token gains the access on the next call —",
    "no re-auth. Use this when doco_search/doco_capture is denied, or to step up",
    "reader→writer.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      doco: {
        type: "string",
        description: "Handle of the Doco to request access to (in this workspace).",
      },
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
      doco: {
        type: "string",
        description: "Handle of the Doco to read from (must be in this workspace).",
      },
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
    "doco_capture). The result's `footer_lines` are ready-to-paste protocol",
    "lines — emit each verbatim and count them toward your closing tally.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      doco: {
        type: "string",
        description: "Handle of the Doco to write to (must be in this workspace).",
      },
      operations: {
        type: "array",
        description:
          "Ordered ops: {op:'create',node_type,alias?,body} | {op:'relate',relation_kind,from,to,lifecycle?} | {op:'relate_many',relations:[…]} | {op:'append',node_type,after,relation_kind,body} | {op:'activate',target} | {op:'queue',target,retire_active_edges?} | {op:'retire',target,retire_active_edges?} | {op:'supersede',target,node_type,body}. activate/queue/retire/supersede `target` is a node id or a $alias from this batch. Edges share the node lifecycle: an ACTIVE edge can only connect ACTIVE nodes — relate `lifecycle` (drafting|queued|active) defaults to active iff both endpoints are active, else drafting. When demoting a node off active, pass `retire_active_edges:true` to also retire its active edges.",
        items: { type: "object", additionalProperties: true },
      },
      validate_against: {
        type: "string",
        description:
          "Optional perspective to check structural integrity against (e.g. 'process'); returns an integrity summary alongside the results.",
      },
    },
    required: ["doco", "operations"],
  },
};

const POLICY_TOOL = {
  name: "doco_policy",
  description: [
    "Write or modify an authoring policy on a Doco — the rules that govern how",
    "the Doco is authored (kind: suggestion | deterministic | probabilistic).",
    "Policies are Doco-level metadata, NOT nodes, and live on a dedicated",
    "endpoint; owner role is required. Two modes:",
    "  • create — omit `id`; `body` MUST include `kind` plus the per-kind draft.",
    "  • modify — pass an existing `id` (policy_…). A content modify (a draft",
    "    with `kind`) SUPERSEDES: it captures a new policy and retires the old",
    "    with superseded_by, returning the NEW id. A `body` of just",
    '    { "lifecycle": "retired" | "active" } retires or re-activates in place.',
    "Read the body shape at /<doco>/api/policies.txt first; list existing",
    "policies with doco_get resource='api/policies.json'.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      doco: {
        type: "string",
        description: "Handle of the Doco to write to (must be in this workspace).",
      },
      id: {
        type: "string",
        description: "Existing policy id (policy_…) to MODIFY. Omit to CREATE a new policy.",
      },
      body: {
        type: "object",
        description:
          "Policy fields. On create / content modify: { kind, ...draft } where kind is suggestion|deterministic|probabilistic. To only retire/re-activate: { lifecycle: 'retired' | 'active' }. See /<doco>/api/policies.txt.",
        additionalProperties: true,
      },
    },
    required: ["doco", "body"],
  },
};

const WHOAMI_TOOL = {
  name: "doco_whoami",
  description: [
    "Identity + reach for the current credential: who you're acting as, the",
    "workspace(s) this connection reaches (every one you belong to on an 'act as",
    "me' token, or the single workspace a scoped token pins), the relevant",
    "constitution, and which Docos you can touch, with your role in each. Call",
    "this FIRST to orient — it's how you find a project's Doco handle (the",
    "<handle> in /<handle>) without guessing. No arguments.",
  ].join("\n"),
  inputSchema: { type: "object", properties: {} },
};

const LIST_WORKSPACES_TOOL = {
  name: "list_workspaces",
  description: [
    "List every Doco Workspace you belong to, with your role in each. On an",
    '"act as me" connection (all your workspaces, one Doco at a time) this is how',
    "you discover what you can reach; a Doco's <handle> works with the other",
    "tools regardless of which workspace it lives in. No arguments.",
  ].join("\n"),
  inputSchema: { type: "object", properties: {} },
};

const AGENT_DEBUG_TOOL = {
  name: "doco_agent_debug",
  description: [
    "Read PRODUCTION Señor Doco diagnostics — the data behind",
    "/admin/agent-debug.json. Restricted to the Doco host superadmin; for",
    "anyone else it returns a denial. Use it to investigate a real incident",
    "from the deployed app (a stuck/failed turn, a missing attachment, a",
    "capture error) without a human pasting logs.",
    "",
    "With no arguments: recent turns (with input/output tokens, stop_reason,",
    "error, phases), in-flight/stuck conversations, and recent capture/model",
    "errors — the last `limit` of each (default 20).",
    "",
    "`search`: find conversations whose messages contain a phrase (e.g. a",
    "quote from a screenshot) — returns conversation ids so you can drill in.",
    "",
    "`conversation`: tail that thread's last `messages` rows AND return a",
    "replay-window analysis: for every attached file, whether the model still",
    "sees it on the next turn or it was evicted by the message/token cap or",
    "deleted by the 30-day retention purge. This is how you answer 'why did",
    "Señor Doco say it didn't have the file I attached?'.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      conversation: {
        type: "string",
        description: "Conversation id to tail and analyze (e.g. conversation_01…).",
      },
      search: {
        type: "string",
        description: "Find conversations whose message content contains this phrase.",
      },
      messages: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        default: 30,
        description:
          "How many of the conversation's most recent messages to return (with `conversation`).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 20,
        description: "Cap on each row list (turns, stuck, errors, search hits). Default 20.",
      },
    },
  },
};

const TOOLS = [
  WHOAMI_TOOL,
  LIST_WORKSPACES_TOOL,
  SEARCH_TOOL,
  GET_TOOL,
  CAPTURE_TOOL,
  RELATE_TOOL,
  CHANGESET_TOOL,
  POLICY_TOOL,
  REQUEST_ACCESS_TOOL,
  AGENT_DEBUG_TOOL,
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

interface Ctx {
  workspaceId: string;
  workspaceHandle: string;
  principalId: string;
  // Actor "act as me" mode (the app-wide `/mcp` with an actor token): the
  // connection reaches EVERY workspace the human belongs to instead of one.
  // `workspaceId`/`workspaceHandle` are empty; tools resolve Docos globally and
  // per-Doco access is enforced live (capped at actor_role) when each tool
  // replays the bearer. `list_workspaces` is how the agent discovers targets.
  allWorkspaces?: boolean;
}

function rpcResult(id: Rpc["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: Rpc["id"], code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

function unauthorized(metadataUrl: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`,
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

// A route denial becomes a clean JSON-RPC tool error — never a raw transport
// status a connector might misread as an auth failure. A missing write grant
// is an authorization problem: ask an owner to grant it (a matrix change), not
// re-authenticate.
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
// caller's bearer so the route's own auth + per-type grant checks gate access.
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

// Resolve a tool's `doco` argument to a Doco owned by THIS workspace. Returns
// the canonical handle or a tool error — the workspace boundary in one place.
async function inWorkspace(
  ctx: Ctx,
  rawDoco: unknown,
): Promise<{ handle: string } | { error: ToolResult }> {
  const doco = String(rawDoco ?? "").trim();
  if (!doco) return { error: toolError("a `doco` handle is required.") };
  if (ctx.allWorkspaces) {
    // Actor mode: no single-workspace boundary. Resolve the handle globally;
    // whether THIS user may touch it (and at what role) is enforced when the
    // tool replays the bearer — enforceOauthGrant resolves an actor token live
    // against the human's membership, capped at actor_role.
    const row = await getDocoByIdOrHandle(doco); // already excludes soft-deleted
    if (!row) return { error: toolError(`Doco "${doco}" not found.`) };
    return { handle: row.handle };
  }
  const resolved = await resolveDocoInWorkspace(doco, ctx.workspaceId);
  if (!resolved.ok) return { error: toolError(resolved.message) };
  return { handle: resolved.handle };
}

async function runDocoSearch(
  request: Request,
  ctx: Ctx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  const resolved = await inWorkspace(ctx, args.doco);
  if ("error" in resolved) return resolved.error;
  const doco = resolved.handle;
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
  const origin = new URL(request.url).origin;
  const url = `${origin}/${encodeURIComponent(doco)}/search.json?q=${encodeURIComponent(query)}&limit=${limit}`;
  const req = new Request(url, { headers: bearerHeaders(request) });
  return delegate("search", doco, () =>
    searchLoader({ request: req, params: { docoHandle: doco } as never }),
  );
}

async function runDocoCapture(
  request: Request,
  ctx: Ctx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = await inWorkspace(ctx, args.doco);
  if ("error" in resolved) return resolved.error;
  const doco = resolved.handle;
  // The per-type capture routes are keyed by the PLURAL type. Accept singular
  // or plural and normalize.
  const rawType = String(args.type ?? "")
    .trim()
    .toLowerCase();
  const type = rawType && !rawType.endsWith("s") ? `${rawType}s` : rawType;
  const body = args.body;
  if (!type) return toolError("doco_capture requires `doco` and `type`.");
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

async function runDocoRelate(
  request: Request,
  ctx: Ctx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = await inWorkspace(ctx, args.doco);
  if ("error" in resolved) return resolved.error;
  const doco = resolved.handle;
  const edgeType = String(args.edge_type ?? "").trim();
  const fromId = String(args.from_id ?? "").trim();
  const toId = String(args.to_id ?? "").trim();
  if (!edgeType || !fromId || !toId) {
    return toolError("doco_relate requires `doco`, `edge_type`, `from_id`, and `to_id`.");
  }
  const payload: Record<string, unknown> = { edge_type: edgeType, from_id: fromId, to_id: toId };
  for (const k of ["label", "condition", "kind", "lifecycle"] as const) {
    if (typeof args[k] === "string") payload[k] = args[k];
  }
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
  ctx: Ctx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = await inWorkspace(ctx, args.doco);
  if ("error" in resolved) return resolved.error;
  const doco = resolved.handle;
  const operations = args.operations;
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

// doco_policy writes or modifies a Doco's authoring policies. Policies have a
// dedicated endpoint (they are not nodes), so it delegates to the policies
// routes rather than the generic node dispatcher: POST /api/policies.json to
// create, PATCH /api/policies/<id>.json to modify (a draft supersedes; a bare
// `{lifecycle}` transitions). The route's own owner gate enforces access.
async function runDocoPolicy(
  request: Request,
  ctx: Ctx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = await inWorkspace(ctx, args.doco);
  if ("error" in resolved) return resolved.error;
  const doco = resolved.handle;
  const body = args.body;
  if (!body || typeof body !== "object") {
    return toolError(
      "doco_policy requires a `body` object — see /<doco>/api/policies.txt for the shape.",
    );
  }
  const id = String(args.id ?? "").trim();
  const origin = new URL(request.url).origin;
  if (id) {
    const url = `${origin}/${encodeURIComponent(doco)}/api/policies/${encodeURIComponent(id)}.json`;
    const req = new Request(url, {
      method: "PATCH",
      headers: bearerHeaders(request, { "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    return delegate("modify a policy in", doco, () =>
      policyIdAction({ request: req, params: { docoHandle: doco, id } as never }),
    );
  }
  const url = `${origin}/${encodeURIComponent(doco)}/api/policies.json`;
  const req = new Request(url, {
    method: "POST",
    headers: bearerHeaders(request, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return delegate("write a policy to", doco, () =>
    policiesAction({ request: req, params: { docoHandle: doco } as never }),
  );
}

// doco_get is the generic read surface: it GETs any document under the Doco's
// HTTP API (or the root /status.json) with the caller's bearer replayed.
async function runDocoGet(
  request: Request,
  ctx: Ctx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = await inWorkspace(ctx, args.doco);
  if ("error" in resolved) return resolved.error;
  const doco = resolved.handle;
  const resource = String(args.resource ?? "")
    .trim()
    .replace(/^\/+/, "");
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

// doco_whoami: identity + reach. On an "act as me" (actor) connection it
// surfaces every workspace the human belongs to and every reachable Doco; on a
// workspace-scoped connection it surfaces just the pinned workspace and its
// Docos (filtering out anything outside it — belt-and-braces for cookie
// sessions, whose membership listing is broader) plus that workspace's
// constitution.
// list_workspaces: every workspace the human belongs to, with their role. The
// primary discovery tool on an "act as me" connection; harmless (and still
// correct) on a single-workspace one.
async function runListWorkspaces(request: Request): Promise<ToolResult> {
  const identity = await loadAgentIdentity(request);
  if (!identity) return toolError("Not authenticated.");
  const workspaces = (identity.grants ?? []).filter((g) => g.scope === "workspace");
  if (workspaces.length === 0) {
    return {
      content: [{ type: "text", text: "You don't belong to any workspaces yet." }],
      structuredContent: { workspaces: [] },
    };
  }
  const lines = [
    "Your workspaces (a Doco's <handle> works with the tools regardless of which one it's in):",
  ];
  for (const w of workspaces) lines.push(`  • ${w.label} (${w.id}): ${w.role}`);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      workspaces: workspaces.map((w) => ({ id: w.id, handle: w.label, role: w.role })),
    },
  };
}

async function runDocoWhoami(request: Request, ctx: Ctx): Promise<ToolResult> {
  const identity = await loadAgentIdentity(request);
  if (!identity) return toolError("Not authenticated.");
  const grants = identity.grants ?? [];
  if (ctx.allWorkspaces) {
    // Actor mode: reach every workspace the human belongs to. Surface them all,
    // and every Doco — pass any Doco's <handle> to the tools.
    const workspaces = grants.filter((g) => g.scope === "workspace");
    const docos = grants.filter((g) => g.scope === "doco");
    const lines: string[] = [
      `Authenticated as ${identity.indicator_prefix}.`,
      'This is an "act as me" connection: it reaches every workspace you belong to, one Doco at a time. Call list_workspaces to see them, then pass any Doco\'s <handle> to the tools.',
    ];
    if (workspaces.length > 0) {
      lines.push("", "Your workspaces:");
      for (const w of workspaces) lines.push(`  • ${w.label} (${w.id}): ${w.role}`);
    }
    if (docos.length > 0) {
      lines.push("", "Docos you can reach (the <handle> in /<handle>):");
      for (const d of docos) lines.push(`  • ${d.label}: ${d.role}`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: { ...identity, all_workspaces: true, grants },
    };
  }
  const workspace = grants.find((g) => g.scope === "workspace" && g.id === ctx.workspaceId);
  const docos = grants.filter(
    (g) => g.scope === "doco" && g.label.startsWith(`${ctx.workspaceHandle}/`),
  );
  const lines: string[] = [
    `Authenticated as ${identity.indicator_prefix}.`,
    `This MCP is bound to workspace ${ctx.workspaceHandle} (${ctx.workspaceId})${
      workspace ? `: ${workspace.role}` : ""
    }.`,
  ];
  if (docos.length > 0) {
    lines.push("Docos you can reach here (the <handle> in /<handle>):");
    for (const d of docos) lines.push(`  • ${d.label}: ${d.role}`);
  } else {
    lines.push(
      "No Docos reachable yet in this workspace — use doco_request_access to ask an owner.",
    );
  }
  // The workspace constitution — the same charter the in-page Señor Doco and the
  // agent-bootstrap manifest surface. Scoped to THIS workspace (the only one
  // this MCP reaches), so a connected agent honors the same top-level intent.
  const [charter] = await getWorkspaceConstitutionsByIds([ctx.workspaceId]);
  const constitution = charter?.constitution ?? null;
  if (constitution) {
    lines.push(
      "",
      `Workspace constitution — the charter your work in ${ctx.workspaceHandle} must honor:`,
      constitution,
    );
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      ...identity,
      workspace_id: ctx.workspaceId,
      workspace_constitution: constitution,
      grants: [workspace, ...docos].filter(Boolean),
    },
  };
}

// Not a delegate: requesting access is a first-party action. Still constrained
// to a Doco in this workspace.
async function runDocoRequestAccess(ctx: Ctx, args: Record<string, unknown>): Promise<ToolResult> {
  const resolved = await inWorkspace(ctx, args.doco);
  if ("error" in resolved) return resolved.error;
  const doco = resolved.handle;
  const role = String(args.role ?? "")
    .trim()
    .toLowerCase();
  const reason = args.reason == null ? null : String(args.reason);
  if (role !== "reader" && role !== "writer" && role !== "owner") {
    return toolError("doco_request_access `role` must be reader, writer, or owner.");
  }
  const result = await requestDocoAccess({
    docoHandleOrId: doco,
    requesterId: ctx.principalId,
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

// doco_agent_debug: production incident diagnostics. NOT Doco-scoped — it reads
// app-wide Señor Doco telemetry, so it ignores `ctx` and gates purely on the
// acting human being the host superadmin. Works on any connection (including
// the actor "act as me" one), so the superadmin can diagnose from any session.
async function runAgentDebug(request: Request, args: Record<string, unknown>): Promise<ToolResult> {
  const identity = await loadAgentIdentity(request);
  if (!isSuperadmin(identity?.username)) {
    return toolError(
      "doco_agent_debug is restricted to the Doco host superadmin. Your credential isn't authorized for production diagnostics.",
    );
  }
  const report = await gatherAgentDebug({
    limit: typeof args.limit === "number" ? args.limit : undefined,
    conversation: typeof args.conversation === "string" ? args.conversation : null,
    messages: typeof args.messages === "number" ? args.messages : undefined,
    search: typeof args.search === "string" ? args.search : null,
  });
  return { content: [{ type: "text", text: JSON.stringify(report) }], structuredContent: report };
}

async function dispatch(message: Rpc, request: Request, ctx: Ctx): Promise<Response> {
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
          return rpcResult(message.id, await runDocoWhoami(request, ctx));
        case "list_workspaces":
          return rpcResult(message.id, await runListWorkspaces(request));
        case "doco_search":
          return rpcResult(message.id, await runDocoSearch(request, ctx, args));
        case "doco_get":
          return rpcResult(message.id, await runDocoGet(request, ctx, args));
        case "doco_capture":
          return rpcResult(message.id, await runDocoCapture(request, ctx, args));
        case "doco_relate":
          return rpcResult(message.id, await runDocoRelate(request, ctx, args));
        case "doco_changeset":
          return rpcResult(message.id, await runDocoChangeset(request, ctx, args));
        case "doco_policy":
          return rpcResult(message.id, await runDocoPolicy(request, ctx, args));
        case "doco_request_access":
          return rpcResult(message.id, await runDocoRequestAccess(ctx, args));
        case "doco_agent_debug":
          return rpcResult(message.id, await runAgentDebug(request, args));
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
  const origin = new URL(request.url).origin;
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;

  // Identity + reach come from the token, not the URL (gateUserMcp): an actor
  // token reaches every workspace the user belongs to, a scoped token pins one.
  const gate = await gateUserMcp(request);
  if (!gate.ok) {
    if (gate.kind === "unauthenticated") return unauthorized(metadataUrl);
    if (gate.kind === "not_found") return new Response(gate.message, { status: 404 });
    return rpcError(null, -32001, gate.message, 403);
  }

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
  return dispatch(message, request, gate.ctx);
}
