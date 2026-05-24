#!/usr/bin/env node
// Doco MCP server. Exposes Doco's search endpoint plus device-flow
// authentication as first-class MCP tools so agents in environments
// without project-scope hook execution (Claude Code on the Web,
// sandboxed runtimes) can both query the Doco and acquire credentials
// without leaving the tool catalog.
//
// Why an MCP server: tool descriptions and the serverInfo.instructions
// field reach the model in clean framing, so the discoverability that
// the SessionStart hook used to provide via additionalContext can be
// reproduced through a delivery channel that survives the sandbox.
//
// Why zero dependencies: matches .agents/doco-agent-client.mjs. The
// MCP wire protocol is JSON-RPC 2.0 over newline-delimited JSON on
// stdio. The handful of methods we need (initialize, tools/list,
// tools/call, plus graceful no-ops for ping / resources / prompts)
// are short enough that pulling in @modelcontextprotocol/sdk would
// dominate the file size.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "doco";
const SERVER_VERSION = "0.2.0";
const DEFAULT_HOST = "https://doco.to";
const DEFAULT_TIMEOUT_MS = 8000;

const REGISTER_PATH = "/oauth/register";
const DEVICE_AUTH_PATH = "/oauth/device_authorization";
const TOKEN_PATH = "/oauth/token";
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 120;
const DEFAULT_REDIRECT_URI = "http://localhost:53682/callback";

const PROJECT_ROOT = findProjectRoot(process.cwd());
const PROJECT_HASH = createHash("sha256").update(PROJECT_ROOT).digest("hex").slice(0, 16);
const DEVICE_STATE_FILE = join(tmpdir(), `doco-mcp-device-${PROJECT_HASH}.json`);
const DEVICE_ENV_KEYS = [
  "DOCO_DEVICE_CLIENT_ID",
  "DOCO_DEVICE_CODE",
  "DOCO_DEVICE_INTERVAL",
  "DOCO_DEVICE_EXPIRES_AT",
  "DOCO_DEVICE_TARGET_HANDLE",
  "DOCO_DEVICE_REQUESTED_ROLE",
];

const SERVER_INSTRUCTIONS = [
  "This project is tracked in a Doco. Doco is institutional memory for",
  "software projects — a structured, searchable record of intent,",
  "decisions, rules, actions, and history. It captures the WHY as it",
  "forms (alternatives weighed, constraints, rules emerging from bugs),",
  "complementing git (which captures the WHAT) and PR descriptions",
  "(which capture some WHY at merge time only).",
  "",
  "Available tools:",
  "- doco_search: query the project's Doco for relevant prior context.",
  "- doco_authenticate: start OAuth device flow when search returns 401/403.",
  "- doco_complete_authentication: finalize OAuth after the user approves.",
  "",
  "Credential sharing: agents working in the same local repository share",
  "the repo-root .env credential. This server rereads .env for every Doco",
  "call and prefers it over stale inherited environment variables, so if",
  "another agent in this checkout just authorized, retry doco_search before",
  "asking the user to approve again. Separate clones or machines need their",
  "own local .env because credentials are secret and must not be committed.",
  "",
  "When to call doco_search: before answering substantive questions about",
  "this project's conventions, prior decisions, or architectural history.",
  "There is almost always prior art you'd otherwise miss. Cheap to call;",
  "skip only for greetings or trivially scoped questions.",
  "",
  "Capture rules are per-Doco. Each Doco's policies (fetched at bootstrap)",
  "decide what — if anything — to capture. The universal protocol does NOT",
  "mandate captures; follow whatever the active Doco's policies say.",
  "",
  "HTTP API body structure: capture specs exist for decisions, intents,",
  "actions, logs, rules, evals, references, states, ideas, policies,",
  "settings, and principals. Principals expose a smaller surface (create",
  "+ retire only) — read the `principals.txt` spec rather than assuming",
  "the generic capture body. Invites and audit have dedicated route",
  "behavior; do not infer write bodies for them from the generic capture",
  "pattern.",
  "",
  "Before POST/PATCH, read `GET /<handle>/api/<type>.txt` for the exact",
  "request body when that spec exists. Principal references in request",
  "bodies use principal ids only: `*_principal_id` for one principal and",
  "`*_principal_ids` for arrays. Do not send principal names, `*_name`",
  "fields, or comma-separated strings; there are no aliases.",
  "",
  "Common API-facing principal fields:",
  "- `wanted_by_principal_id`: Intent owner; auth fills this when omitted.",
  "- `actors_principal_ids`: Intent actors; always an array of principal ids.",
  "- `stakeholders_principal_ids`: Intent stakeholders; always an array.",
  "- `actor_principal_id`: Action/Log actor; auth fills this when omitted.",
  "- `decided_by_principal_id`: Decision maker; auth fills this when omitted.",
  "- `authored_by_principal_id`: Rule/Eval/Policy author; auth fills this.",
  "- `created_by_principal_id`: creator override where supported.",
  "",
  "Read responses may expose stored graph fields such as `wanted_by`,",
  "`actors`, `stakeholders`, `actor_id`, `decided_by`, and `created_by`.",
  "Those are storage field names; write requests should use the",
  "API-facing principal-id fields above.",
  "",
  "Rendering order matters. Text between tool calls is shown to the user",
  "as those tool calls run, so render indicators AROUND tool calls, not all",
  "at the end:",
  "- On the first reply of a session that uses Doco, render `[🔮 Doco]",
  "  Loading <handle>...` as the very first text, BEFORE any tool call.",
  "- Before calling doco_search, render `[🔮 Doco] <corky verb>...` (only",
  "  if you have DOCO_ACCESS and expect success — skip otherwise).",
  "- After doco_search succeeds, render `[🔮 Doco] N neurons found (X.Xs)`.",
  "",
  "If doco_search returns 401/403 (or you have no DOCO_ACCESS after this",
  "server has checked the shared repo .env):",
  "1. Call doco_authenticate. It returns a ready-to-render block with a",
  "   clickable verification URL in markdown-link form.",
  "2. Render that block at the top of your reply. The user clicks the link,",
  "   signs in to Doco, and clicks Approve.",
  "3. Immediately call doco_complete_authentication with wait_seconds=120",
  "   in the same turn. Do not wait for the user to send another message;",
  "   the tool blocks while polling — that's the intentional pause.",
  "4. If it succeeds: retry doco_search and continue normally.",
  "5. If it returns 'still pending' or any error: end your reply with the",
  "   tally and a brief 'send any message after approving'. DO NOT",
  "   continue substantive work without Doco access — the pause is",
  "   intentional. Doco contains prior decisions and rules; doing work",
  "   that hasn't checked them risks contradicting them.",
  "",
  "Auth: this server reads DOCO_ACCESS from the repo-root .env first, then",
  "the spawning shell, and forwards it as a Bearer token. Successful device",
  "auth writes back to that same .env so other agents in this local checkout",
  "reuse the credential. Public Docos work without auth.",
  "",
  "Persisting credentials across containers and clones — surface to the user",
  "ONCE after each successful auth (the doco_complete_authentication response",
  "already includes the exact wording). The two options the protocol",
  "supports:",
  "",
  "  1. DOCO_ACCESS as a runtime environment variable. The user sets it on",
  "     the *remote execution environment* (Claude Code on the Web env vars,",
  "     Codespaces secrets, etc.). Every fresh container inherits it; no",
  "     re-auth needed. Private to the user; never commit.",
  "",
  "  2. Committable project tokens. The Doco owner mints a read-only token",
  "     at <host>/<handle>/project-tokens and commits it to",
  "     .doco/project-tokens.json. Any agent cloning the repo can read the",
  "     Doco without auth. Only suitable when the Doco's contents are OK to",
  "     be readable by anyone who can read the repo. This MCP server reads",
  "     .doco/project-tokens.json automatically when no DOCO_ACCESS is set.",
  "",
  "Do NOT prompt for these on every auth — once per successful auth is the",
  "limit. The user can act on the suggestion or move on.",
].join("\n");

const SEARCH_TOOL = {
  name: "doco_search",
  description: [
    "Search this project's Doco (institutional memory of decisions, rules,",
    "intents, actions, and history). Returns ranked neurons by vector",
    "similarity to the query.",
    "",
    "CALL THIS BEFORE answering substantive questions about how this project",
    "does things — conventions, prior decisions, why a thing exists, what",
    "was tried before. There is almost always prior art in the Doco that",
    "you would otherwise miss.",
    "",
    "Skip only for greetings, off-topic chat, or questions clearly outside",
    "the project's scope.",
    "",
    "On 401/403, call doco_authenticate to acquire credentials, then retry.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Free-text query. Vector search; phrasing flexible.",
      },
      limit: {
        type: "integer",
        description: "Maximum hits to return (default 10, max 50).",
        minimum: 1,
        maximum: 50,
        default: 10,
      },
    },
    required: ["query"],
  },
};

const AUTH_TOOL = {
  name: "doco_authenticate",
  description: [
    "Start OAuth device-flow authentication against the Doco. Call this when",
    "doco_search returns 401 (no credential) or 403 (credential lacks access).",
    "",
    "Returns IMMEDIATELY with a verification URL and user code. Show the URL",
    "to the user verbatim and tell them to open it in their browser and",
    "approve. The device code is valid for 15 minutes.",
    "",
    "After showing the URL, immediately call doco_complete_authentication",
    "in the same turn to finalize. Do not wait for the user to send another",
    "message; that tool polls and writes the access token to the shared",
    "repo-root .env on approval so other agents in this checkout can reuse it.",
    "",
    "This server reuses an OAuth client_id across calls (stored in .env as",
    "DOCO_CLIENT_ID), so registration only happens on first use.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      target_doco_handle: {
        type: "string",
        description:
          "Doco handle to request access to. Defaults to the first handle found in .doco/connections.md.",
      },
      requested_role: {
        type: "string",
        enum: ["reader", "author", "approver", "owner"],
        default: "reader",
        description:
          "Role level to request. 'reader' suffices for doco_search; 'author' is needed for future capture tools.",
      },
    },
  },
};

const COMPLETE_AUTH_TOOL = {
  name: "doco_complete_authentication",
  description: [
    "Call this immediately after rendering the URL returned by",
    "doco_authenticate. It polls the token endpoint until the user approves",
    "(or the wait_seconds budget expires), so the agent can learn about",
    "approval without waiting for another user message.",
    "",
    "On success: writes DOCO_ACCESS, DOCO_REFRESH, DOCO_CLIENT_ID to ./.env",
    "(mode 0600). Subsequent doco_search calls from any agent in this local",
    "checkout will use the new token.",
    "",
    "If this returns 'still pending', the user hasn't approved yet. Wait a",
    "few seconds and call again — the device code remains valid for 15",
    "minutes from doco_authenticate.",
    "",
    "If this returns 'expired' or 'denied', call doco_authenticate again to",
    "start a fresh flow.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      wait_seconds: {
        type: "integer",
        minimum: 5,
        maximum: MAX_WAIT_SECONDS,
        default: DEFAULT_WAIT_SECONDS,
        description: `Maximum seconds to poll before returning 'pending'. Default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}.`,
      },
    },
  },
};

const TOOLS = [SEARCH_TOOL, AUTH_TOOL, COMPLETE_AUTH_TOOL];

const rl = createInterface({ input: stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    logStderr(`failed to parse incoming message: ${error.message}`);
    return;
  }
  handleMessage(message).catch((error) => {
    logStderr(`unhandled error in handler: ${error.message}`);
    if (message?.id !== undefined) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: `Internal error: ${error.message}` },
      });
    }
  });
});
// Don't exit synchronously on stdin EOF — the event loop will drain
// once in-flight async handlers (fetch calls) resolve and write their
// responses. Forcing exit here would abort tool calls mid-request.

async function handleMessage(message) {
  if (message.jsonrpc !== "2.0") return;

  // Notifications have no id and expect no response.
  if (message.id === undefined) {
    if (
      message.method === "notifications/initialized" ||
      message.method === "notifications/cancelled"
    ) {
      return;
    }
    return;
  }

  switch (message.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: SERVER_INSTRUCTIONS,
        },
      });

    case "ping":
      return send({ jsonrpc: "2.0", id: message.id, result: {} });

    case "tools/list":
      return send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });

    case "tools/call":
      return handleToolCall(message);

    case "resources/list":
      return send({ jsonrpc: "2.0", id: message.id, result: { resources: [] } });

    case "prompts/list":
      return send({ jsonrpc: "2.0", id: message.id, result: { prompts: [] } });

    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
  }
}

async function handleToolCall(message) {
  const params = message.params || {};
  switch (params.name) {
    case SEARCH_TOOL.name:
      return handleSearch(message);
    case AUTH_TOOL.name:
      return handleAuthenticate(message);
    case COMPLETE_AUTH_TOOL.name:
      return handleCompleteAuthenticate(message);
    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: `Unknown tool: ${params.name}` },
      });
  }
}

async function handleSearch(message) {
  const args = message.params?.arguments || {};
  const query = String(args.query || "").trim();
  if (!query) {
    return errorResult(message.id, "doco_search requires a non-empty `query` argument.");
  }
  const limit = clampLimit(args.limit);

  const access = readEnv("DOCO_ACCESS").trim();
  const handle = readEnv("DOCO_HANDLE") || readDocoHandle();
  if (!handle) {
    return errorResult(
      message.id,
      "No Doco URL found in .doco/connections.md. Set DOCO_HANDLE in .env or add the connections file.",
    );
  }

  const host = normalizeHost(readEnv("DOCO_HOST") || DEFAULT_HOST);
  const url = new URL(`/${encodeURIComponent(handle)}/search.json`, host);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  const result = await requestJson(url, { access });
  if (!result.ok) {
    return errorResult(message.id, formatErrorForAgent(result, handle, access));
  }

  return send({
    jsonrpc: "2.0",
    id: message.id,
    result: { content: [{ type: "text", text: formatHits(result.body, handle) }] },
  });
}

async function handleAuthenticate(message) {
  const args = message.params?.arguments || {};
  const handle =
    String(args.target_doco_handle || "").trim() || readEnv("DOCO_HANDLE") || readDocoHandle();
  if (!handle) {
    return errorResult(
      message.id,
      "No target_doco_handle and no Doco URL found in .doco/connections.md.",
    );
  }
  const role = String(args.requested_role || "reader");

  const host = normalizeHost(readEnv("DOCO_HOST") || DEFAULT_HOST);
  let clientId = readEnv("DOCO_CLIENT_ID").trim();
  if (!clientId) {
    const reg = await registerClient(host);
    if (!reg.ok) {
      return errorResult(
        message.id,
        `OAuth client registration failed (HTTP ${reg.status}): ${reg.error || reg.code}`,
      );
    }
    clientId = String(reg.body?.client_id || "");
    if (!clientId) {
      return errorResult(message.id, "OAuth registration returned no client_id.");
    }
    writeEnvUpdates({ DOCO_CLIENT_ID: clientId });
  }

  const auth = await initiateDeviceFlow(host, { clientId, handle, role });
  if (!auth.ok) {
    return errorResult(
      message.id,
      `Device authorization failed (HTTP ${auth.status}): ${auth.error || auth.code}`,
    );
  }
  const deviceCode = String(auth.body?.device_code || "");
  const userCode = String(auth.body?.user_code || "");
  const verifyUrl = String(
    auth.body?.verification_uri_complete || auth.body?.verification_uri || "",
  );
  const interval = Math.max(1, Number(auth.body?.interval ?? 5));
  const expiresIn = Math.max(60, Number(auth.body?.expires_in ?? 900));
  if (!deviceCode || !userCode || !verifyUrl) {
    return errorResult(
      message.id,
      `Device authorization response missing required fields: ${JSON.stringify(auth.body)}`,
    );
  }

  writeDeviceState({
    client_id: clientId,
    device_code: deviceCode,
    interval,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    target_doco_handle: handle,
    requested_role: role,
  });

  // Return a ready-to-render block. The agent should quote this verbatim
  // at the top of its reply. Markdown link syntax renders the URL clickable
  // in chat clients that render markdown (Claude Code, Cursor, etc.).
  // The indicator line uses the requested handle/org name so the user
  // sees exactly which scope they're being asked to grant.
  const text = [
    "Device-flow authentication started. Render the following block at the top of your reply (the URL is in markdown-link syntax so it renders clickable):",
    "",
    "---",
    `[🔮 Doco] ${handle} access not granted yet`,
    "",
    `To let me read this project's prior decisions and rules, open [${verifyUrl}](${verifyUrl}) and click Approve. I'll pause here until you do.`,
    "---",
    "",
    `User code (if the URL doesn't auto-fill): ${userCode}`,
    `Device code expires in ${Math.round(expiresIn / 60)} minutes.`,
    "",
    "Then immediately call doco_complete_authentication with wait_seconds=120 in this same turn to pause while the user approves. DO NOT wait for the user to send another message, and DO NOT continue substantive work until it succeeds — the pause is intentional. If it returns 'still pending', end your turn with the tally and ask the user to send any message after approving.",
    "",
    `In the closing tally for this turn, render: [🔮 Doco] ⚠️ ${handle} not queried or updated as access hasn't been granted yet. (until completion succeeds; then switch to the normal tally line for ${handle}).`,
  ].join("\n");

  return send({
    jsonrpc: "2.0",
    id: message.id,
    result: { content: [{ type: "text", text }] },
  });
}

async function handleCompleteAuthenticate(message) {
  const args = message.params?.arguments || {};
  const state = readDeviceState();
  if (!state) {
    return errorResult(
      message.id,
      "No device-authorization flow in progress for this project. Call doco_authenticate first.",
    );
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec >= state.expires_at) {
    clearDeviceState();
    return errorResult(
      message.id,
      "Device code expired. Call doco_authenticate to start a fresh flow.",
    );
  }

  const host = normalizeHost(readEnv("DOCO_HOST") || DEFAULT_HOST);
  const waitSeconds = clampWait(args.wait_seconds);
  const deadline = Date.now() + waitSeconds * 1000;
  let interval = Math.max(1, Number(state.interval || 5));

  while (true) {
    const poll = await pollTokenOnce(host, state.client_id, state.device_code);
    if (poll.kind === "approved") {
      const tokens = poll.tokens;
      const accessToken = String(tokens.access_token || "");
      writeEnvUpdates({
        DOCO_ACCESS: accessToken,
        ...(tokens.refresh_token ? { DOCO_REFRESH: String(tokens.refresh_token) } : {}),
        DOCO_CLIENT_ID: state.client_id,
      });
      clearDeviceState();
      const role = state.requested_role || "reader";
      const handle = state.target_doco_handle || "(unknown handle)";
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: formatAuthSuccessText({ handle, role, accessToken, host }),
            },
          ],
        },
      });
    }
    if (poll.kind === "denied") {
      clearDeviceState();
      return errorResult(
        message.id,
        "Authorization denied by the user. Call doco_authenticate to retry.",
      );
    }
    if (poll.kind === "expired") {
      clearDeviceState();
      return errorResult(
        message.id,
        "Device code expired. Call doco_authenticate to start a fresh flow.",
      );
    }
    if (poll.kind === "slow_down") {
      interval += 5;
    } else if (poll.kind === "error") {
      return errorResult(message.id, `Polling failed: ${poll.error}`);
    }
    // Otherwise: pending. Decide whether to keep waiting.
    const msLeft = deadline - Date.now();
    if (msLeft < interval * 1000) {
      const elapsedSec = waitSeconds - Math.max(0, Math.ceil(msLeft / 1000));
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: `Still pending after ~${elapsedSec}s of polling. The device code is still valid for another ${Math.max(0, state.expires_at - Math.floor(Date.now() / 1000))}s. Call doco_complete_authentication again to keep waiting.`,
            },
          ],
        },
      });
    }
    await delay(interval * 1000);
  }
}

async function registerClient(host) {
  const url = new URL(REGISTER_PATH, host);
  return requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Doco MCP Server",
      redirect_uris: [DEFAULT_REDIRECT_URI],
    }),
  });
}

async function initiateDeviceFlow(host, { clientId, handle, role }) {
  const url = new URL(DEVICE_AUTH_PATH, host);
  const params = new URLSearchParams({
    client_id: clientId,
    scope: "doco",
    target_doco_handle: handle,
    requested_role: role,
  });
  return requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

async function pollTokenOnce(host, clientId, deviceCode) {
  const url = new URL(TOKEN_PATH, host);
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: clientId,
  });
  const r = await requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (r.ok && r.body?.access_token) {
    return { kind: "approved", tokens: r.body };
  }
  const errCode = typeof r.body === "object" && r.body ? String(r.body.error || "") : "";
  switch (errCode) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "access_denied":
      return { kind: "denied" };
    case "expired_token":
      return { kind: "expired" };
    default:
      if (r.code === "network" || r.code === "timeout") {
        return { kind: "pending" }; // transient — retry
      }
      return { kind: "error", error: r.error || errCode || `HTTP ${r.status}` };
  }
}

function formatAuthSuccessText({ handle, role, accessToken, host }) {
  // After a successful device-flow auth, every fresh container or new
  // clone has to repeat this dance — unless the user persists the
  // credential somewhere durable. Surface the two options the protocol
  // supports so the agent can tell the user once, right when the pain
  // is fresh.
  //
  // Why both options every time: most agents can't reliably detect
  // whether they're in an ephemeral sandbox or on a persistent local
  // machine, and the project-token option depends on a per-Doco
  // sensitivity judgement only the user can make. Cheaper to surface
  // both and let the user pick than to guess wrong.
  const tokenSuffix = accessToken ? accessToken.slice(-6) : "";
  const tokenHint = tokenSuffix ? ` (token ending …${tokenSuffix})` : "";
  return [
    `Authenticated. Wrote DOCO_ACCESS to ./.env (mode 0600). You now have ${role} access to Doco '${handle}'${tokenHint}. Retry doco_search.`,
    "",
    "TELL THE USER ONCE, NOW: this auth dance repeats on every fresh container or new machine unless they persist the credential. The two options:",
    "",
    "1. Set DOCO_ACCESS as a persistent environment variable on the *remote execution environment* (not the repo) — fresh containers then inherit it without prompting. For Claude Code on the Web, the Environment configuration is at https://code.claude.com/docs/en/claude-code-on-the-web. Other sandboxes (Codespaces, Replit, etc.) expose a similar env-vars setting. The DOCO_ACCESS value is private to the user; do not paste it for them, just tell them to copy it from .env.",
    "",
    `2. If this Doco's contents are OK to be readable by anyone with read access to this repository, the Doco owner can mint a "project token" — a committable, read-only token stored in .doco/project-tokens.json. Any agent cloning the repo then reads the Doco without authenticating. Mint at ${host}/${handle}/project-tokens (owner-only, requires explicit confirmation that repo readers = acceptable Doco readers).`,
    "",
    "Both are optional. Surface them once and continue with the substantive answer; do not re-prompt on every turn.",
  ].join("\n");
}

function formatHits(body, handle) {
  if (!body || typeof body !== "object") {
    return `Doco search returned no parseable body for handle '${handle}'.`;
  }
  const count = Number(body.count ?? 0);
  const ms = Number(body.duration_ms ?? 0);
  const secs = (ms / 1000).toFixed(1);
  const hits = Array.isArray(body.hits) ? body.hits : [];
  // Doco-level goal description rides along on every search response so
  // the agent sees what this Doco is for the moment it queries it.
  const goal = String(body.doco_goal || "").trim();
  const goalPrefix = goal ? `Doco goal: ${goal}\n\n` : "";

  if (count === 0) {
    return `${goalPrefix}No matches in Doco '${handle}' (${secs}s). Either the project has no prior neurons covering this, or the query phrasing missed them — try synonyms.`;
  }

  const lines = [
    `${goalPrefix}Found ${count} neuron${count === 1 ? "" : "s"} in Doco '${handle}' (${secs}s):`,
    "",
  ];
  for (const hit of hits) {
    const type = hit.entity_type || hit.neuron_type || "neuron";
    const id = hit.slug || hit.seq_id || hit.id || "?";
    const summary = String(hit.summary || "").trim();
    const truncated = summary.length > 200 ? `${summary.slice(0, 197)}…` : summary;
    lines.push(`- ${type} [${id}]: ${truncated || "(no summary)"}`);
  }
  return lines.join("\n");
}

function formatErrorForAgent(result, handle, hadAccess) {
  const status = result.status || 0;
  const code = result.code || "";
  const error = result.error || "request failed";

  if (status === 401) {
    return `Doco search unauthorized (401) for handle '${handle}'. ${
      hadAccess
        ? "Your DOCO_ACCESS is invalid or expired — call doco_authenticate to acquire a fresh credential."
        : "No DOCO_ACCESS in the shared repo-root .env. Call doco_authenticate to start the OAuth device flow."
    }`;
  }
  if (status === 403) {
    return `Doco search forbidden (403) for handle '${handle}'. ${
      hadAccess
        ? `The current credential lacks read access to this Doco. Call doco_authenticate with target_doco_handle='${handle}' to request access (a project owner will need to approve).`
        : "No DOCO_ACCESS sent from the shared repo-root .env (and the Doco is private). Call doco_authenticate to start the OAuth device flow."
    }`;
  }
  if (status === 404) {
    return `Doco '${handle}' not found (404). Verify the URL in .doco/connections.md.`;
  }
  if (code === "network" || code === "timeout" || status === 0) {
    return `Could not reach Doco at the configured host (${code}: ${error}). Check network policy / allowlist for doco.to.`;
  }
  return `Doco search failed (HTTP ${status}, ${code}): ${error}`;
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const headers = { ...(options.headers || {}) };
    if (options.access) headers.Authorization = `Bearer ${options.access}`;
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body,
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseJson(text);
    const out = {
      ok: response.ok,
      status: response.status,
      code: response.ok ? "ok" : "http",
      body,
    };
    if (!response.ok) {
      out.error =
        (body &&
          typeof body === "object" &&
          (body.error_description || body.error || body.warning || body.message)) ||
        `HTTP ${response.status}`;
    }
    return out;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      code: error?.name === "AbortError" ? "timeout" : "network",
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function clampLimit(raw) {
  const n = Number.parseInt(String(raw ?? 10), 10);
  if (!Number.isFinite(n) || n < 1) return 10;
  if (n > 50) return 50;
  return n;
}

function clampWait(raw) {
  const n = Number.parseInt(String(raw ?? DEFAULT_WAIT_SECONDS), 10);
  if (!Number.isFinite(n) || n < 5) return 5;
  if (n > MAX_WAIT_SECONDS) return MAX_WAIT_SECONDS;
  return n;
}

function normalizeHost(raw) {
  return String(raw || DEFAULT_HOST).replace(/\/+$/, "") || DEFAULT_HOST;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readEnv(name) {
  const envFile = readEnvFile();
  const fromEnvFile = envFile[name];
  if (fromEnvFile) return fromEnvFile;
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  // Committable per-repo fallback for DOCO_ACCESS. The Doco owner can
  // mint a read-only "project token" and commit it to
  // .doco/project-tokens.json — any agent cloning the repo can then
  // read the Doco without authenticating, as long as the Doco's
  // contents are OK to be readable by anyone who can read the repo.
  if (name === "DOCO_ACCESS") {
    const handle = readDocoHandle();
    const projectToken = readProjectToken(handle);
    if (projectToken) return projectToken;
  }
  return "";
}

function readEnvFile() {
  const path = join(PROJECT_ROOT, ".env");
  if (!existsSync(path)) return {};
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    out[match[1]] = unquote(match[2].trim());
  }
  return out;
}

function writeEnvUpdates(updates) {
  const path = join(PROJECT_ROOT, ".env");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const updateKeys = new Set(Object.keys(updates));
  const keepLines = existing.split(/\r?\n/).filter((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    return !(match && updateKeys.has(match[1]));
  });
  while (keepLines.length > 0 && keepLines[keepLines.length - 1] === "") keepLines.pop();
  for (const [k, v] of Object.entries(updates)) {
    keepLines.push(`${k}=${v}`);
  }
  keepLines.push("");
  writeFileSync(path, keepLines.join("\n"), { mode: 0o600 });
}

function clearEnvKeys(keys) {
  const path = join(PROJECT_ROOT, ".env");
  if (!existsSync(path)) return;
  const deleteKeys = new Set(keys);
  const keepLines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
      return !(match && deleteKeys.has(match[1]));
    });
  while (keepLines.length > 0 && keepLines[keepLines.length - 1] === "") keepLines.pop();
  keepLines.push("");
  writeFileSync(path, keepLines.join("\n"), { mode: 0o600 });
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readProjectToken(handle) {
  if (!handle) return "";
  const path = join(PROJECT_ROOT, ".doco", "project-tokens.json");
  if (!existsSync(path)) return "";
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const value = parsed[handle];
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed.startsWith("doco_pt_")) return "";
  return trimmed;
}

function readDocoHandle() {
  for (const relativePath of [".doco/connections.md"]) {
    const path = join(PROJECT_ROOT, relativePath);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const matches = text.matchAll(/https?:\/\/[^/\s)]+\/([A-Za-z0-9][A-Za-z0-9-]*)\/?/g);
    for (const match of matches) {
      const handle = match[1];
      if (handle !== "invite" && handle !== "api") return handle;
    }
  }
  return "";
}

function findProjectRoot(start) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".doco", "connections.md"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

function readDeviceState() {
  const fileState = readDeviceStateFile();
  if (fileState) return fileState;
  return readDeviceStateEnv();
}

function readDeviceStateFile() {
  if (!existsSync(DEVICE_STATE_FILE)) return null;
  try {
    const raw = readFileSync(DEVICE_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeDeviceState(parsed);
  } catch {
    return null;
  }
}

function readDeviceStateEnv() {
  const env = readEnvFile();
  return normalizeDeviceState({
    client_id: env.DOCO_DEVICE_CLIENT_ID,
    device_code: env.DOCO_DEVICE_CODE,
    interval: env.DOCO_DEVICE_INTERVAL,
    expires_at: env.DOCO_DEVICE_EXPIRES_AT,
    target_doco_handle: env.DOCO_DEVICE_TARGET_HANDLE,
    requested_role: env.DOCO_DEVICE_REQUESTED_ROLE,
  });
}

function normalizeDeviceState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const clientId = String(raw.client_id || "").trim();
  const deviceCode = String(raw.device_code || "").trim();
  const expiresAt = Number(raw.expires_at);
  if (!clientId || !deviceCode || !Number.isFinite(expiresAt)) return null;
  return {
    client_id: clientId,
    device_code: deviceCode,
    interval: Math.max(1, Number(raw.interval || 5)),
    expires_at: expiresAt,
    target_doco_handle: String(raw.target_doco_handle || "").trim(),
    requested_role: String(raw.requested_role || "reader").trim() || "reader",
  };
}

function writeDeviceState(state) {
  writeFileSync(DEVICE_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  writeEnvUpdates({
    DOCO_DEVICE_CLIENT_ID: state.client_id,
    DOCO_DEVICE_CODE: state.device_code,
    DOCO_DEVICE_INTERVAL: String(state.interval),
    DOCO_DEVICE_EXPIRES_AT: String(state.expires_at),
    DOCO_DEVICE_TARGET_HANDLE: state.target_doco_handle,
    DOCO_DEVICE_REQUESTED_ROLE: state.requested_role,
  });
}

function clearDeviceState() {
  try {
    unlinkSync(DEVICE_STATE_FILE);
  } catch {
    // Already gone — fine.
  }
  clearEnvKeys(DEVICE_ENV_KEYS);
}

function errorResult(id, text) {
  return send({
    jsonrpc: "2.0",
    id,
    result: { isError: true, content: [{ type: "text", text }] },
  });
}

function send(message) {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function logStderr(text) {
  stderr.write(`[doco-mcp] ${text}\n`);
}
