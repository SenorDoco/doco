#!/usr/bin/env node
// Doco MCP server. Exposes Doco's search endpoint as a first-class MCP
// tool so agents in environments without project-scope hook execution
// (Claude Code on the Web, sandboxed runtimes) can still query the Doco
// without relying on AGENTS.md content that the harness wraps in
// "may or may not be relevant" framing.
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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout, stderr } from "node:process";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "doco";
const SERVER_VERSION = "0.1.0";
const DEFAULT_HOST = "https://doco.to";
const DEFAULT_TIMEOUT_MS = 8000;

const SERVER_INSTRUCTIONS = [
  "This project is tracked in a Doco — institutional memory of decisions,",
  "rules, intents, actions, and history, with vector search across nodes.",
  "",
  "Available tools:",
  "- doco_search: query the project's Doco for relevant prior context",
  "",
  "When to call doco_search: before answering substantive questions about",
  "this project's conventions, prior decisions, or architectural history.",
  "There is almost always prior art you'd otherwise miss. Cheap to call;",
  "skip only for greetings or trivially scoped questions.",
  "",
  "Auth: this server reads DOCO_ACCESS from ./.env or the spawning shell",
  "and forwards it as a Bearer token. Public Docos work without auth.",
].join("\n");

const SEARCH_TOOL = {
  name: "doco_search",
  description: [
    "Search this project's Doco (institutional memory of decisions, rules,",
    "intents, actions, and history). Returns ranked nodes by vector",
    "similarity to the query.",
    "",
    "CALL THIS BEFORE answering substantive questions about how this project",
    "does things — conventions, prior decisions, why a thing exists, what",
    "was tried before. There is almost always prior art in the Doco that",
    "you would otherwise miss.",
    "",
    "Skip only for greetings, off-topic chat, or questions clearly outside",
    "the project's scope.",
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

let envFileCache;

const rl = createInterface({ input: stdin, crlfDelay: Infinity });
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
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
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
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [SEARCH_TOOL] },
      });

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
  if (params.name !== SEARCH_TOOL.name) {
    return send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32602, message: `Unknown tool: ${params.name}` },
    });
  }

  const args = params.arguments || {};
  const query = String(args.query || "").trim();
  if (!query) {
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isError: true,
        content: [{ type: "text", text: "doco_search requires a non-empty `query` argument." }],
      },
    });
  }
  const limit = clampLimit(args.limit);

  const access = readEnv("DOCO_ACCESS").trim();
  const handle = readEnv("DOCO_HANDLE") || readDocoHandle();
  if (!handle) {
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: "No Doco URL found in .doco/connections.md, DOCO.md, or doco.md. Set DOCO_HANDLE in .env or add the connections file.",
          },
        ],
      },
    });
  }

  const host = normalizeHost(readEnv("DOCO_HOST") || DEFAULT_HOST);
  const url = new URL(`/${encodeURIComponent(handle)}/search.json`, host);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  const result = await requestJson(url, access);
  if (!result.ok) {
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isError: true,
        content: [
          { type: "text", text: formatErrorForAgent(result, handle) },
        ],
      },
    });
  }

  return send({
    jsonrpc: "2.0",
    id: message.id,
    result: {
      content: [{ type: "text", text: formatHits(result.body, handle) }],
    },
  });
}

function formatHits(body, handle) {
  if (!body || typeof body !== "object") {
    return `Doco search returned no parseable body for handle '${handle}'.`;
  }
  const count = Number(body.count ?? 0);
  const ms = Number(body.duration_ms ?? 0);
  const secs = (ms / 1000).toFixed(1);
  const hits = Array.isArray(body.hits) ? body.hits : [];

  if (count === 0) {
    return `No matches in Doco '${handle}' (${secs}s). Either the project has no prior nodes covering this, or the query phrasing missed them — try synonyms.`;
  }

  const lines = [`Found ${count} node${count === 1 ? "" : "s"} in Doco '${handle}' (${secs}s):`, ""];
  for (const hit of hits) {
    const type = hit.node_type || "node";
    const id = hit.slug || hit.seq_id || hit.id || "?";
    const summary = String(hit.summary || "").trim();
    const truncated = summary.length > 200 ? `${summary.slice(0, 197)}…` : summary;
    lines.push(`- ${type} [${id}]: ${truncated || "(no summary)"}`);
  }
  return lines.join("\n");
}

function formatErrorForAgent(result, handle) {
  const status = result.status || 0;
  const code = result.code || "";
  const error = result.error || "request failed";

  if (status === 401) {
    return `Doco search unauthorized (401) for handle '${handle}'. DOCO_ACCESS is missing or invalid — ask the project owner for an invite URL, then write it into ./.env as DOCO_ACCESS.`;
  }
  if (status === 403) {
    return `Doco search forbidden (403) for handle '${handle}'. The current credential lacks access to this Doco.`;
  }
  if (status === 404) {
    return `Doco '${handle}' not found (404). Verify the URL in .doco/connections.md or DOCO.md.`;
  }
  if (code === "network" || code === "timeout" || status === 0) {
    return `Could not reach Doco at the configured host (${code}: ${error}). Check network policy / allowlist for doco.to.`;
  }
  return `Doco search failed (HTTP ${status}, ${code}): ${error}`;
}

async function requestJson(url, access) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const headers = {};
    if (access) headers.Authorization = `Bearer ${access}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    const body = parseJson(text);
    const out = { ok: response.ok, status: response.status, code: response.ok ? "ok" : "http", body };
    if (!response.ok) {
      out.error = (body && typeof body === "object" && (body.error || body.warning || body.message)) || `HTTP ${response.status}`;
    }
    return out;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, code: error?.name === "AbortError" ? "timeout" : "network", error: message };
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
  if (process.env[name]) return process.env[name];
  envFileCache ??= readEnvFile();
  return envFileCache[name] || "";
}

function readEnvFile() {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return {};
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    out[match[1]] = unquote(match[2].trim());
  }
  return out;
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function readDocoHandle() {
  for (const relativePath of [".doco/connections.md", "DOCO.md", "doco.md"]) {
    const path = join(process.cwd(), relativePath);
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

function send(message) {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function logStderr(text) {
  stderr.write(`[doco-mcp] ${text}\n`);
}
