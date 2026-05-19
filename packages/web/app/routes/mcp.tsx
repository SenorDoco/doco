// POST /mcp/:handle — Model Context Protocol (Streamable HTTP transport).
//
// One MCP server per Doco. The runtime installs
// `https://doco.to/mcp/<handle>` as an MCP server; the handle
// disambiguates which Doco this connection serves. The OAuth access
// token (validated via /oauth/token) gates whether `<handle>` is in
// the user's granted_doco_ids — tokens scoped to other Docos cannot
// reach this one.
//
// PARITY RULE (captured as a guidance Rule on #global): web, API, and
// MCP must offer the same functionality. If the JSON API grows a new
// endpoint, this connector grows a new tool in the same change.
//
// Authentication: OAuth 2.1 access token in `Authorization: Bearer`,
// minted via /oauth/token (decision_01KS14CW9ZN23FF5CGG0Z7TH4G).
// Unauthenticated requests get 401 + WWW-Authenticate with a pointer
// to the resource-metadata document — the MCP runtime treats that as
// "kick off the OAuth dance."
//
// Architecture: every capture / patch / read tool is a thin
// authenticated HTTPS proxy to the corresponding /<handle>/api/...
// endpoint. The MCP server adds zero behavior; it's a protocol
// adapter only. Adding a new tool when the API grows means: add a
// row to TOOLS + a row to the dispatcher map. The actual logic
// (validation, scope-gate checks, capture/audit) stays in the JSON
// routes where the web + the API surface call it from.
//
// Protocol surface implemented:
//   - initialize           — handshake
//   - notifications/initialized — one-way ack
//   - tools/list           — return tool registry
//   - tools/call           — invoke tool by name + args

import { getDocoByIdOrHandle } from "@doco/db";
import type { EntityId } from "@doco/shared";
import { AGENT_REFERENCE, CANONICAL_INSTRUCTIONS } from "~/lib/instructions.server";
import { validateAccessToken } from "~/lib/oauth-server.server";
import { extractBearer } from "~/lib/session";

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

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const MCP_AUTH_REQUIRED = -32001;
const MCP_TOOL_FAILED = -32002;

function rpcOk(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcErr(id: JsonRpcId, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// Authentication.
// ---------------------------------------------------------------------------

interface ResolvedSession {
  agentId: EntityId<"principal">;
  docoId: EntityId<"doco">;
  docoHandle: string;
  /** Raw bearer passed through to internal HTTPS proxies so they
   *  resolve to the same Principal/Doco via the same auth code path. */
  rawCredential: string;
  /** Origin of the host (deployed prod vs preview). The proxy
   *  computes this from the incoming request URL. */
  origin: string;
}

type ResolveResult =
  | { kind: "ok"; session: ResolvedSession }
  | { kind: "unauthenticated" }
  | { kind: "forbidden"; reason: string };

async function resolveSession(request: Request, handle: string): Promise<ResolveResult> {
  const credential = extractBearer(request);
  if (!credential) return { kind: "unauthenticated" };
  const token = await validateAccessToken(credential);
  if (!token) return { kind: "unauthenticated" };
  const doco = await getDocoByIdOrHandle(handle);
  if (!doco) return { kind: "forbidden", reason: `Doco "${handle}" not found.` };
  if (!token.granted_doco_ids.includes(doco.id)) {
    return {
      kind: "forbidden",
      reason: `Token not authorized for Doco "${handle}". Re-authorize at /oauth/authorize to include this Doco in the grant.`,
    };
  }
  const url = new URL(request.url);
  return {
    kind: "ok",
    session: {
      agentId: token.principal_id as EntityId<"principal">,
      docoId: doco.id as EntityId<"doco">,
      docoHandle: doco.handle,
      rawCredential: credential,
      origin: `${url.protocol}//${url.host}`,
    },
  };
}

function wwwAuthenticateHeader(request: Request, error?: string): string {
  const url = new URL(request.url);
  const resourceMetadata = `${url.protocol}//${url.host}/.well-known/oauth-protected-resource`;
  const errorPart = error ? `, error="${error}"` : "";
  return `Bearer realm="doco", resource_metadata="${resourceMetadata}"${errorPart}`;
}

// ---------------------------------------------------------------------------
// Internal API proxy — every tool funnels through here.
// ---------------------------------------------------------------------------

interface ProxyOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path template; `{handle}` and any `{var}` placeholders are filled
   *  from session.docoHandle + the args. */
  path: string;
  /** Args interpreted as URL placeholders (consumed; not sent in body). */
  pathArgs?: string[];
  /** Args interpreted as querystring. */
  queryArgs?: string[];
  /** Remaining args land in the JSON body for POST/PATCH. */
  bodyAllowed?: boolean;
}

async function proxyApi(
  session: ResolvedSession,
  opts: ProxyOptions,
  args: Record<string, unknown>,
): Promise<unknown> {
  let path = opts.path.replace("{handle}", session.docoHandle);
  const argsCopy: Record<string, unknown> = { ...args };
  for (const v of opts.pathArgs ?? []) {
    const raw = argsCopy[v];
    if (typeof raw !== "string" || !raw) {
      throw new Error(`Missing required path argument: ${v}`);
    }
    path = path.replace(`{${v}}`, encodeURIComponent(raw));
    delete argsCopy[v];
  }
  const query = new URLSearchParams();
  for (const v of opts.queryArgs ?? []) {
    const raw = argsCopy[v];
    if (raw === undefined || raw === null) continue;
    query.set(v, String(raw));
    delete argsCopy[v];
  }
  const url = `${session.origin}${path}${query.toString() ? `?${query}` : ""}`;
  const init: RequestInit = {
    method: opts.method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${session.rawCredential}`,
    },
  };
  if (opts.method !== "GET" && opts.bodyAllowed !== false) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(argsCopy);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(
      `${opts.method} ${path} → ${res.status} ${res.statusText}: ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`,
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// Tool registry.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  proxy: ProxyOptions;
}

// Common JSON-Schema fragments reused across capture-tool schemas.
const SCOPE_NAMES_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description:
    "At least one scope name (hashtag-shaped, e.g. '#important'). File on the scope whose allowed_node_types accepts this node type — see list_scopes.",
};

const TOOLS: ToolDef[] = [
  // -------------------- Read tools --------------------
  {
    name: "bootstrap",
    description:
      "Fetch the current canonical_instructions + per-Doco context (scopes, constitution, onboarding_overlay). Call once per session before drafting any capture or reply.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    proxy: { method: "GET", path: "/api/v1/agent-bootstrap" },
  },
  {
    name: "search",
    description:
      "Vector + keyword search across the connected Doco's nodes. Use BEFORE drafting any new capture to avoid duplicates.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Free-text query." },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["q"],
      additionalProperties: false,
    },
    proxy: { method: "GET", path: "/{handle}/search.json", queryArgs: ["q", "limit"] },
  },
  {
    name: "list_scopes",
    description:
      "List live scopes with their purpose, icon, allowed_node_types, lifecycle, and is_watched. Use this to pick the right scope for a capture.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    proxy: { method: "GET", path: "/{handle}/api/scopes.json" },
  },
  {
    name: "get_status",
    description:
      "Doco freshness + per-type node counts. Useful before declaring 'onboarding done' to verify the scope checklist actually has content.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    proxy: { method: "GET", path: "/{handle}/status.json" },
  },
  {
    name: "get_audit",
    description:
      "Audit-log events (captures, patches, lifecycle changes) for this Doco. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 200 },
        since: {
          type: "string",
          description: "ISO 8601 timestamp; return events on or after.",
        },
      },
      additionalProperties: false,
    },
    proxy: { method: "GET", path: "/{handle}/api/audit.json", queryArgs: ["limit", "since"] },
  },
  {
    name: "list_principals",
    description: "List principals (humans + agents) connected to this Doco.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    proxy: { method: "GET", path: "/{handle}/api/principals.json" },
  },
  // -------------------- Capture tools (one per node type) --------------------
  {
    name: "capture_decision",
    description:
      "Capture a Decision node — a one-time choice with alternatives considered. File on a scope whose accepts includes 'decision' (typically #important or a topical scope like #adrs).",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        chosen: { type: "string" },
        scope_names: SCOPE_NAMES_SCHEMA,
        summary: { type: "string" },
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
        },
        intent_ids: { type: "array", items: { type: "string" } },
        body_md: { type: "string" },
      },
      required: ["question", "chosen", "scope_names"],
      additionalProperties: false,
    },
    proxy: { method: "POST", path: "/{handle}/api/decisions.json" },
  },
  {
    name: "capture_intent",
    description:
      "Capture an Intent node — a goal or aim. Lives upstream of Decisions and Actions that serve it.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-line 'what someone wants' summary." },
        scope_names: SCOPE_NAMES_SCHEMA,
        title: { type: "string" },
        body_md: { type: "string", description: "Context + non-goals + success criteria." },
        wanted_by_username: { type: "string" },
        actors_usernames: {
          type: "array",
          items: { type: "string" },
          description: "Principals expected to act in this flow.",
        },
        lifecycle: { type: "string" },
      },
      required: ["summary", "scope_names"],
      additionalProperties: false,
    },
    proxy: { method: "POST", path: "/{handle}/api/intents.json" },
  },
  {
    name: "capture_action",
    description:
      "Capture an Action node — a step in a flow, an edit, a deploy, an interaction. The unit of progress.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        scope_names: SCOPE_NAMES_SCHEMA,
        verb: { type: "string", description: "Short verb (refactor, migrate, deploy, …)." },
        intent_ids: { type: "array", items: { type: "string" } },
        decision_ids: { type: "array", items: { type: "string" } },
        follows: { type: "array", items: { type: "string" } },
        inputs: {},
        outputs: {},
        performed_by_username: { type: "string" },
        body_md: { type: "string" },
        lifecycle: { type: "string" },
      },
      required: ["summary", "scope_names", "verb"],
      additionalProperties: false,
    },
    proxy: { method: "POST", path: "/{handle}/api/actions.json" },
  },
  {
    name: "capture_log",
    description:
      "Capture a Log node — something that happened, with a timestamp and concrete outputs. Distinct from Action: Logs are observational, Actions are deliberate.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        scope_names: SCOPE_NAMES_SCHEMA,
        verb: {
          type: "string",
          description: "Past-tense verb (pushed, deployed, verified).",
        },
        happened_at: {
          type: "string",
          description: "ISO 8601 UTC timestamp of when the event occurred.",
        },
        outputs: {
          type: "object",
          description: "Concrete output values (commit hash, deploy URL, verification result).",
        },
        template_id: {
          type: "string",
          description: "Optional Action template this Log instances.",
        },
        intent_ids: { type: "array", items: { type: "string" } },
        decision_ids: { type: "array", items: { type: "string" } },
        follows: { type: "array", items: { type: "string" } },
        inputs: {},
        performed_by_username: { type: "string" },
        body_md: { type: "string" },
        lifecycle: { type: "string" },
      },
      required: ["summary", "scope_names", "verb", "happened_at", "outputs"],
      additionalProperties: false,
    },
    proxy: { method: "POST", path: "/{handle}/api/logs.json" },
  },
  {
    name: "capture_rule",
    description:
      "Capture a Rule node — a standing constraint that applies to its scope. Pick `doco-node-authoring` kind (with a predicate) when the rule gates Doco-node captures (e.g. 'every ADR must include alternatives_considered' — the predicate evaluates an incoming Decision POST). Pick `guidance` for reminders the agent surfaces without enforcement (workflow rules, dev conventions). Note: `doco-node-authoring` (preferred) and legacy `authoring` are both accepted on the wire for back-compat. Posts to a SPECIFIC scope's /rules endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        scope_id: {
          type: "string",
          description: "The id of the scope this rule attaches to (from list_scopes).",
        },
        kind: {
          type: "string",
          enum: ["doco-node-authoring", "guidance", "authoring"],
          description:
            "`doco-node-authoring` (preferred) or legacy `authoring` for predicate-bearing capture-gate rules; `guidance` for reminders without enforcement.",
        },
        prose: { type: "string", description: "The rule prose (what the rule says)." },
        summary: { type: "string", description: "Optional one-line summary." },
      },
      required: ["scope_id", "kind", "prose"],
      additionalProperties: false,
    },
    proxy: {
      method: "POST",
      path: "/{handle}/api/scopes/{scope_id}/rules.json",
      pathArgs: ["scope_id"],
    },
  },
  {
    name: "capture_eval",
    description:
      "Capture an Eval node — a test or measurement (exact value, shape check, or LLM-judge criterion).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short readable name." },
        scope_names: SCOPE_NAMES_SCHEMA,
        criterion: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["exact", "shape", "llm-judge"] },
            spec: { type: "string" },
          },
          required: ["kind"],
        },
        body_md: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        input: {},
        expected: {},
        target_ref: { type: "string", description: "Id of the entity this Eval tests." },
        intent_ids: { type: "array", items: { type: "string" } },
        authored_by_username: { type: "string" },
        lifecycle: { type: "string" },
      },
      required: ["name", "scope_names", "criterion"],
      additionalProperties: false,
    },
    proxy: { method: "POST", path: "/{handle}/api/evals.json" },
  },
  {
    name: "capture_reference",
    description:
      "Capture a Reference node — a pointer to external material (URL, doc, spec, contract).",
    inputSchema: {
      type: "object",
      properties: {
        ref_type: { type: "string", description: "URL / file / spec / etc." },
        locator: { type: "string", description: "The URL or path." },
        scope_names: SCOPE_NAMES_SCHEMA,
        summary: { type: "string" },
        body_md: { type: "string" },
        content_hash: { type: "string" },
        intent_ids: { type: "array", items: { type: "string" } },
        created_by_username: { type: "string" },
        lifecycle: { type: "string" },
      },
      required: ["ref_type", "locator", "scope_names"],
      additionalProperties: false,
    },
    proxy: { method: "POST", path: "/{handle}/api/references.json" },
  },
  {
    name: "capture_state",
    description:
      "Capture a State node — a named state in a state machine (typically used inside the #state-machines scope).",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "State display name (e.g. 'paid', 'cart')." },
        scope_names: SCOPE_NAMES_SCHEMA,
        kind: { type: "string", enum: ["initial", "intermediate", "terminal"] },
        invariants: {
          type: "array",
          items: { type: "string" },
          description: "Free-form predicates true while in this State.",
        },
        follows: { type: "array", items: { type: "string" } },
        created_by_username: { type: "string" },
        body_md: { type: "string" },
        lifecycle: { type: "string" },
      },
      required: ["summary", "scope_names", "kind"],
      additionalProperties: false,
    },
    proxy: { method: "POST", path: "/{handle}/api/states.json" },
  },
  // -------------------- Patch tools (one per patchable node type) --------------------
  // Each patch endpoint accepts a partial of its draft. Schemas
  // intentionally permissive (additionalProperties: true) so the
  // route's own validation owns shape correctness — the MCP server
  // doesn't re-derive it.
  {
    name: "patch_decision",
    description:
      "Extend an existing Decision (add alternatives, update body_md, change lifecycle). Use this when search.vector_score > ~0.45 — strictly preferred over opening a sibling node.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The Decision's ULID." },
      },
      required: ["id"],
      additionalProperties: true,
    },
    proxy: { method: "PATCH", path: "/{handle}/api/decisions/{id}.json", pathArgs: ["id"] },
  },
  {
    name: "patch_intent",
    description: "Extend an existing Intent.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: true,
    },
    proxy: { method: "PATCH", path: "/{handle}/api/intents/{id}.json", pathArgs: ["id"] },
  },
  {
    name: "patch_action",
    description: "Extend an existing Action.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: true,
    },
    proxy: { method: "PATCH", path: "/{handle}/api/actions/{id}.json", pathArgs: ["id"] },
  },
  {
    name: "patch_rule",
    description: "Extend an existing Rule.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: true,
    },
    proxy: { method: "PATCH", path: "/{handle}/api/rules/{id}.json", pathArgs: ["id"] },
  },
  {
    name: "patch_log",
    description: "Extend an existing Log.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: true,
    },
    proxy: { method: "PATCH", path: "/{handle}/api/logs/{id}.json", pathArgs: ["id"] },
  },
  {
    name: "patch_reference",
    description: "Extend an existing Reference.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: true,
    },
    proxy: {
      method: "PATCH",
      path: "/{handle}/api/references/{id}.json",
      pathArgs: ["id"],
    },
  },
  // -------------------- Scope management --------------------
  {
    name: "create_scope",
    description:
      "Create a new scope. During onboarding, pass watched=true (see bootstrap response's onboarding_overlay.watched_explainer). Otherwise the caller MUST pick watched explicitly.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Scope name (hashtag-shaped; the host prepends '#' if missing).",
        },
        purpose: { type: "string", description: "What this scope is for." },
        icon: { type: "string", description: "Optional emoji or short marker." },
        watched: { type: "boolean" },
        allowed_node_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Node types this scope accepts. Empty/omitted means 'anything'. Examples: ['rule'] (rules-only), ['decision', 'intent'].",
        },
        template_name: {
          type: "string",
          description: "Optional template name (e.g. 'user-flows') to clone defaults from.",
        },
      },
      required: ["name", "watched"],
      additionalProperties: false,
    },
    proxy: { method: "POST", path: "/{handle}/api/scopes.json" },
  },
  {
    name: "activate_scope_draft",
    description: "Activate a draft scope (move lifecycle from 'proposed' / 'draft' to 'active').",
    inputSchema: {
      type: "object",
      properties: { scope_id: { type: "string" } },
      required: ["scope_id"],
      additionalProperties: false,
    },
    proxy: {
      method: "POST",
      path: "/{handle}/api/scopes/{scope_id}/activate.json",
      pathArgs: ["scope_id"],
      bodyAllowed: false,
    },
  },
  // -------------------- Invite management --------------------
  {
    name: "create_invite",
    description:
      "Mint a single-use invite URL the project owner can share with a teammate (human or agent). Defaults to 7-day TTL.",
    inputSchema: {
      type: "object",
      properties: {
        expires_in_days: { type: "number", minimum: 1, maximum: 365 },
      },
      additionalProperties: false,
    },
    proxy: { method: "POST", path: "/{handle}/api/invites.json" },
  },
];

const TOOL_BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// MCP resources. Replaces the HTTP /api/v1/agent-bootstrap +
// /api/v1/agent-reference endpoints: connected runtimes fetch the
// canonical protocol via MCP `resources/read` once per session.
// ---------------------------------------------------------------------------

const CANONICAL_RESOURCE_URI = "doco://protocol/canonical-instructions";
const REFERENCE_RESOURCE_URI = "doco://protocol/agent-reference";

const RESOURCES = [
  {
    uri: CANONICAL_RESOURCE_URI,
    name: "Canonical agent instructions",
    description:
      "The four-invariant protocol every Doco-connected reply must follow (query indicator, footer lines, capture-before-done, tally). Fetch once per session.",
    mimeType: "text/markdown",
  },
  {
    uri: REFERENCE_RESOURCE_URI,
    name: "Agent reference (long form)",
    description:
      "Deep reference — node-type walkthrough, scope onboarding flow, capture checklist, placement examples. Fetch only when the canonical points you here.",
    mimeType: "text/markdown",
  },
] as const;

// ---------------------------------------------------------------------------
// Dispatcher.
// ---------------------------------------------------------------------------

async function callTool(
  session: ResolvedSession,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return await proxyApi(session, tool.proxy, args);
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

export async function action({
  request,
  params: routeParams,
}: {
  request: Request;
  params: { handle?: string };
}) {
  if (request.method !== "POST") {
    return rpcErr(null, INVALID_REQUEST, "MCP transport requires POST");
  }
  const handle = routeParams.handle ?? "";
  if (!handle) {
    return new Response("Per-Doco MCP URL required. Use https://doco.to/mcp/<your-doco-handle>.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
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
        const clientProtocol =
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
        return rpcOk(id, {
          protocolVersion: clientProtocol,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "doco", version: "0.3.0" },
        });
      }
      case "notifications/initialized": {
        return new Response(null, { status: 204 });
      }
      case "tools/list": {
        return rpcOk(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      }
      case "resources/list": {
        return rpcOk(id, { resources: RESOURCES });
      }
      case "resources/read": {
        const uri = typeof params.uri === "string" ? params.uri : "";
        const resource = RESOURCES.find((r) => r.uri === uri);
        if (!resource) {
          return rpcErr(id, INVALID_REQUEST, `unknown resource: ${uri}`);
        }
        const text =
          resource.uri === CANONICAL_RESOURCE_URI ? CANONICAL_INSTRUCTIONS : AGENT_REFERENCE;
        return rpcOk(id, {
          contents: [{ uri: resource.uri, mimeType: "text/markdown", text }],
        });
      }
      case "tools/call": {
        const resolved = await resolveSession(request, handle);
        if (resolved.kind === "unauthenticated") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: {
                code: MCP_AUTH_REQUIRED,
                message:
                  "Authorization required. Acquire an OAuth access token via /oauth/authorize and send `Authorization: Bearer <token>`. See WWW-Authenticate header for discovery.",
              },
            }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "WWW-Authenticate": wwwAuthenticateHeader(request, "invalid_token"),
              },
            },
          );
        }
        if (resolved.kind === "forbidden") {
          return rpcErr(id, MCP_AUTH_REQUIRED, resolved.reason);
        }
        const toolName = typeof params.name === "string" ? params.name : "";
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
        if (!toolName) {
          return rpcErr(id, INVALID_REQUEST, "tools/call requires `name`");
        }
        try {
          const result = await callTool(resolved.session, toolName, toolArgs);
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

export function loader({
  request,
  params,
}: {
  request: Request;
  params: { handle?: string };
}) {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  return Response.json(
    {
      name: "doco",
      version: "0.3.0",
      transport: "streamable-http",
      protocol_versions_supported: ["2024-11-05"],
      handle: params.handle ?? null,
      auth: {
        type: "oauth2.1",
        authorization_server_metadata: `${issuer}/.well-known/oauth-authorization-server`,
        protected_resource_metadata: `${issuer}/.well-known/oauth-protected-resource`,
      },
      tools_exposed: TOOLS.map((t) => t.name),
      parity_rule:
        "MCP tools track the JSON API 1:1. New API endpoints get a new tool in the same change. Captured as a guidance rule on #global.",
      hint: "POST JSON-RPC 2.0 to this URL. See https://modelcontextprotocol.io/specification/draft/basic/transports#streamable-http",
    },
    {
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": wwwAuthenticateHeader(request),
      },
    },
  );
}
