// Doco-wide assistant backend for Señor Doco.
//
// Unlike the old per-node chat, this module receives the current Doco, page
// URL, and browser session principal, then lets the assistant operate across
// the whole Doco through the same capture/update helpers used by the API
// routes. The chat can stay mounted while React Router swaps the page on the
// right, and successful mutations return a `navigate_to` URL so the client can
// move the user to the thing that changed.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import { type DocoRole, getEntity, listAllDocos, roleAtLeast, withClient } from "@doco/db";
import { entityUrl } from "@doco/shared";
import { parse as parseYaml } from "yaml";
import { enforceScopeRoleGate, loadScopeNamesByIds } from "~/lib/api-capture-factory.server";
import {
  type ActionDraft,
  type CaptureError,
  type CaptureResult,
  type DecisionDraft,
  type EntityPatch,
  type IntentDraft,
  type LogDraft,
  type NodeTypeName,
  type ReferenceDraft,
  type RuleDraft,
  captureAction,
  captureDecision,
  captureIntent,
  captureLog,
  captureReference,
  captureRule,
  updateDecision,
  updateEntity,
} from "~/lib/capture.server";
import { docoPath } from "~/lib/db.server";
import { canAccessDoco, getDocoLevelRole } from "~/lib/doco-access.server";
import { type DocoMetadata, readDocoMetadata } from "~/lib/scope-helpers.server";
import type { CurrentPrincipal } from "~/lib/session";

if (!process.env.OPENAI_API_KEY) loadDotEnvFromAncestors();

function loadDotEnvFromAncestors(): void {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        loadEnvFile(candidate);
      } catch {
        // Malformed .env or older Node; ignore.
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

export interface DocoChatOperation {
  tool: string;
  description: string;
  applied: boolean;
  error?: string;
  footer_lines?: string[];
  navigate_to?: string;
}

export interface ChatAttachment {
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
}

export interface RunDocoChatTurnInput {
  docoDir: string;
  docoId: string;
  ownerSlug: string;
  docoSlug: string;
  handle: string;
  meta: DocoMetadata;
  message: string;
  history: ChatTurn[];
  attachments?: ChatAttachment[];
  currentPath: string;
  docoHost: string;
  actor: CurrentPrincipal;
}

export interface RunDocoChatTurnResult {
  reply: string;
  operations: DocoChatOperation[];
  mutated: boolean;
  navigate_to?: string;
}

interface DocoChatDocoContext {
  handle: string;
  docoId: string;
  ownerSlug: string;
  docoSlug: string;
  docoDir: string;
  meta: DocoMetadata;
  role: DocoRole | null;
  isCurrent: boolean;
}

interface ToolTarget {
  ok: true;
  doco: DocoChatDocoContext;
}

interface FastPathToolCall {
  tool: "get_status" | "create_node" | "change_lifecycle" | "add_edge";
  args: Record<string, unknown>;
}

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }[];
}

const PLURAL_DIR: Record<NodeTypeName, string> = {
  decision: "decisions",
  intent: "intents",
  rule: "rules",
  action: "actions",
  log: "logs",
  reference: "references",
  scope: "scopes",
};

const ENTITY_TABLE: Record<string, string> = {
  decision: "decisions",
  intent: "intents",
  rule: "rules",
  action: "actions",
  log: "logs",
  reference: "reference_entities",
  eval: "evals",
  idea: "ideas",
  state: "states",
  scope: "scopes",
};

const COUNT_TABLES = [
  { key: "decisions", nodeType: "decision", table: "decisions" },
  { key: "intents", nodeType: "intent", table: "intents" },
  { key: "rules", nodeType: "rule", table: "rules" },
  { key: "actions", nodeType: "action", table: "actions" },
  { key: "logs", nodeType: "log", table: "logs" },
  { key: "references", nodeType: "reference", table: "reference_entities" },
  { key: "evals", nodeType: "eval", table: "evals" },
  { key: "ideas", nodeType: "idea", table: "ideas" },
  { key: "states", nodeType: "state", table: "states" },
  { key: "scopes", nodeType: "scope", table: "scopes" },
] as const;

const COUNT_TARGETS = new Map<string, string>([
  ["node", "nodes"],
  ["nodes", "nodes"],
  ["edge", "edges"],
  ["edges", "edges"],
  ...COUNT_TABLES.flatMap(({ key, nodeType }) => [[nodeType, key] as const, [key, key] as const]),
]);

const CHAT_NODE_TYPES = new Set<NodeTypeName>([
  "decision",
  "intent",
  "rule",
  "action",
  "log",
  "reference",
  "scope",
]);

const CAPTURE_NODE_TYPES = new Set(["decision", "intent", "rule", "action", "log", "reference"]);

const LIFECYCLES = new Set([
  "active",
  "proposed",
  "planned",
  "drafted",
  "retired",
  "abandoned",
  "superseded",
  "succeeded",
  "failed",
]);

const SYSTEM_PROMPT = `You are Señor Doco, a Doco-wide assistant embedded beside the user's Doco.

You can help with the whole Doco, not just the current page. Prefer fast, exact tool calls when the user asks for a concrete mutation. After a mutation, briefly confirm what changed and let the tool result navigate the page.

Rules:
- Use tools for concrete writes: create nodes, add edges, and change lifecycle.
- Use get_status for count/status questions. Do not call find_nodes with an empty query.
- You can operate on any accessible Doco. If the user names a Doco handle, pass doco_handle exactly. If they do not, use the current visible Doco.
- Respect the current page context. If the user says "this node" or "here", use current_entity_id when present.
- Keep replies short. One or two sentences is usually enough.
- If a request is ambiguous, ask one short clarifying question.
- Scope names always start with "#". Use existing scopes only.
- Valid lifecycle values include: active, proposed, planned, drafted, retired, abandoned, superseded, succeeded, failed.
- Edge creation is field-backed. Common edge types: serves -> Intent, enacts -> Decision, follows -> any node, born_from -> any node, superseded_by -> any node, tests -> any node, in_scope_of -> Scope.

Attachments arrive inline in the current user message. Images arrive as image_url parts. Text-readable files arrive as text parts with a header. Do not invent contents for unreadable files.`;

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_status",
      description:
        "Get Doco-wide counts, including total nodes, edges, and per-node-type totals. Use this for count/status questions.",
      parameters: {
        type: "object",
        properties: {
          doco_handle: {
            type: "string",
            description: "Optional accessible Doco handle. Defaults to the current visible Doco.",
          },
          node_type: {
            type: "string",
            enum: [
              "nodes",
              "edges",
              "decision",
              "intent",
              "rule",
              "action",
              "log",
              "reference",
              "eval",
              "idea",
              "state",
              "scope",
            ],
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find_nodes",
      description: "Search for existing nodes by id or summary before mutating or answering.",
      parameters: {
        type: "object",
        properties: {
          doco_handle: {
            type: "string",
            description: "Optional accessible Doco handle. Defaults to the current visible Doco.",
          },
          query: { type: "string" },
          node_type: {
            type: "string",
            enum: [
              "decision",
              "intent",
              "rule",
              "action",
              "log",
              "reference",
              "eval",
              "idea",
              "state",
              "scope",
              "any",
            ],
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_node",
      description: "Create a new Doco node and navigate to it.",
      parameters: {
        type: "object",
        properties: {
          doco_handle: {
            type: "string",
            description: "Optional accessible Doco handle. Defaults to the current visible Doco.",
          },
          node_type: {
            type: "string",
            enum: ["decision", "intent", "rule", "action", "log", "reference"],
          },
          summary: { type: "string" },
          scope_names: { type: "array", items: { type: "string" } },
          lifecycle: { type: "string" },
          body_md: { type: "string" },
          question: { type: "string" },
          chosen: { type: "string" },
          predicate: { type: "string" },
          verb: { type: "string" },
          ref_type: {
            type: "string",
            enum: ["file", "url", "ticket", "commit", "document", "other"],
          },
          locator: { type: "string" },
          happened_at: { type: "string" },
          outputs: { type: "object" },
        },
        required: ["node_type", "summary", "scope_names"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "change_lifecycle",
      description: "Change a node lifecycle and navigate to the node.",
      parameters: {
        type: "object",
        properties: {
          doco_handle: {
            type: "string",
            description: "Optional accessible Doco handle. Defaults to the current visible Doco.",
          },
          target_id: {
            type: "string",
            description: "Entity id, or current_entity_id from context.",
          },
          lifecycle: { type: "string" },
        },
        required: ["target_id", "lifecycle"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "add_edge",
      description:
        "Add a field-backed edge from one node to another and navigate to the source node.",
      parameters: {
        type: "object",
        properties: {
          doco_handle: {
            type: "string",
            description:
              "Optional accessible Doco handle for the source node. Defaults to the current visible Doco.",
          },
          from_id: { type: "string" },
          to_id: { type: "string" },
          edge_type: {
            type: "string",
            enum: [
              "serves",
              "enacts",
              "follows",
              "born_from",
              "superseded_by",
              "tests",
              "in_scope_of",
            ],
          },
        },
        required: ["from_id", "to_id", "edge_type"],
        additionalProperties: false,
      },
    },
  },
];

const MAX_TOOL_ROUNDS = 5;

export async function runDocoChatTurn(input: RunDocoChatTurnInput): Promise<RunDocoChatTurnResult> {
  const docos = await loadAccessibleDocoContexts(input);
  const fastPath = parseFastPathCommand(input.message, input.attachments, docos, input.handle);
  if (fastPath) {
    const outcome = await applyToolCall({
      tool: fastPath.tool,
      args: fastPath.args,
      input,
      docos,
    });
    const mutated = outcome.applied && isMutatingTool(outcome.tool);
    return {
      reply: fastPathReply(outcome),
      operations: [outcome],
      mutated,
      ...(outcome.navigate_to ? { navigate_to: outcome.navigate_to } : {}),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      reply:
        "OPENAI_API_KEY is missing on the host, so Señor Doco is offline. Set it in the web environment and retry.",
      operations: [],
      mutated: false,
    };
  }

  const context = await loadDocoChatContext(input, docos);
  const messages: OpenAIChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: context },
    ...input.history.map<OpenAIChatMessage>((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    buildCurrentUserMessage(input.message, input.attachments),
  ];

  const operations: DocoChatOperation[] = [];
  let mutated = false;
  let navigateTo: string | undefined;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await callOpenAI(apiKey, messages);
    const choice = completion.choices?.[0]?.message;
    if (!choice) {
      return {
        reply: "(empty response from OpenAI)",
        operations,
        mutated,
        navigate_to: navigateTo,
      };
    }
    messages.push({
      role: "assistant",
      content: typeof choice.content === "string" ? choice.content : null,
      tool_calls: Array.isArray(choice.tool_calls) ? choice.tool_calls : undefined,
    });

    if (!choice.tool_calls || choice.tool_calls.length === 0) {
      return {
        reply: choice.content ?? "(no reply)",
        operations,
        mutated,
        ...(navigateTo ? { navigate_to: navigateTo } : {}),
      };
    }

    for (const call of choice.tool_calls) {
      const outcome = await applyToolCall({
        tool: call.function.name,
        args: parseToolArgs(call.function.arguments),
        input,
        docos,
      });
      operations.push(outcome);
      if (outcome.applied && isMutatingTool(outcome.tool)) mutated = true;
      if (outcome.navigate_to) navigateTo = outcome.navigate_to;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify({
          applied: outcome.applied,
          error: outcome.error ?? null,
          description: outcome.description,
          footer_lines: outcome.footer_lines ?? [],
          navigate_to: outcome.navigate_to ?? null,
        }),
      });
    }
  }

  return {
    reply: "I hit the tool-use limit. Some changes may have applied; check the operation list.",
    operations,
    mutated,
    ...(navigateTo ? { navigate_to: navigateTo } : {}),
  };
}

async function loadAccessibleDocoContexts(
  input: RunDocoChatTurnInput,
): Promise<DocoChatDocoContext[]> {
  const rows = await listAllDocos();
  const out: DocoChatDocoContext[] = [];
  for (const row of rows) {
    const docoDir = docoPath(row.handle);
    const meta = await readDocoMetadata(docoDir).catch(() => null);
    if (!meta) continue;
    if (!(await canAccessDoco(meta, input.actor.id))) continue;
    const role = await getDocoLevelRole(
      { ownerId: meta.ownerId, docoId: meta.docoId },
      input.actor.id,
    );
    out.push({
      handle: row.handle,
      docoId: row.id,
      ownerSlug: row.owner_slug,
      docoSlug: row.handle,
      docoDir,
      meta,
      role,
      isCurrent: row.handle === input.handle,
    });
  }
  if (!out.some((doco) => doco.handle === input.handle)) {
    out.unshift({
      handle: input.handle,
      docoId: input.docoId,
      ownerSlug: input.ownerSlug,
      docoSlug: input.docoSlug,
      docoDir: input.docoDir,
      meta: input.meta,
      role: await getDocoLevelRole(
        { ownerId: input.meta.ownerId, docoId: input.meta.docoId },
        input.actor.id,
      ),
      isCurrent: true,
    });
  }
  return out.sort(
    (a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.handle.localeCompare(b.handle),
  );
}

async function loadDocoChatContext(
  input: RunDocoChatTurnInput,
  docos: DocoChatDocoContext[],
): Promise<string> {
  const scopesByDoco = await withClient(async (c) => {
    const ids = docos.map((doco) => doco.docoId);
    if (ids.length === 0) return new Map<string, string[]>();
    const rows = (
      await c.query<{ doco_id: string; name: string; purpose: string | null }>(
        "SELECT doco_id, name, purpose FROM scopes WHERE doco_id = ANY($1) AND lifecycle IN ('active', 'proposed') ORDER BY name",
        [ids],
      )
    ).rows;
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const list = grouped.get(row.doco_id) ?? [];
      list.push(`${row.name}${row.purpose ? ` — ${row.purpose}` : ""}`);
      grouped.set(row.doco_id, list);
    }
    return grouped;
  });
  const current = await loadCurrentEntitySnapshot(input);
  const docoLines = docos.map((doco) => {
    const marker = doco.isCurrent ? " (current visible Doco, default target)" : "";
    const role = doco.role ? `role=${doco.role}` : "scope-only/read access";
    const scopes = scopesByDoco.get(doco.docoId) ?? [];
    return [
      `- ${doco.handle}${marker}; ${role}`,
      scopes.length
        ? scopes.map((scope) => `  - ${scope}`).join("\n")
        : "  - (no active/proposed scopes)",
    ].join("\n");
  });
  return [
    `Current visible Doco: ${input.handle}`,
    `Current page: ${input.currentPath || "/"}`,
    `Signed-in human principal: ${input.actor.username} (${input.actor.id})`,
    "Accessible Docos and scopes:",
    docoLines.length ? docoLines.join("\n") : "- (none)",
    "",
    "Targeting rule: if the user does not name a Doco, use the current visible Doco. If the user names one of the accessible Doco handles, pass that handle as doco_handle.",
    "",
    current,
  ].join("\n");
}

async function loadCurrentEntitySnapshot(input: RunDocoChatTurnInput): Promise<string> {
  const parsed = parseCurrentEntityPath(input.currentPath, input.handle);
  if (!parsed) return "Current entity: (none)";
  const rec = await getEntity(parsed.nodeType, parsed.id).catch(() => null);
  if (!rec || rec.doco_id !== input.docoId) return "Current entity: (not found)";
  const fm = parseRecord(rec.raw_yaml);
  const scopeNames = await loadScopeNamesByIds(
    Array.isArray(fm.scopes) ? fm.scopes.filter((s): s is string => typeof s === "string") : [],
  );
  const label =
    parsed.nodeType === "scope"
      ? (rec.purpose ?? String(fm.purpose ?? fm.name ?? parsed.id))
      : (rec.summary ?? String(fm.summary ?? fm.name ?? parsed.id));
  return [
    "Current entity:",
    `current_entity_id: ${parsed.id}`,
    `current_entity_type: ${parsed.nodeType}`,
    parsed.nodeType === "scope"
      ? `current_entity_purpose: ${label}`
      : `current_entity_summary: ${label}`,
    `current_entity_lifecycle: ${rec.lifecycle ?? fm.lifecycle ?? "(none)"}`,
    `current_entity_scopes: ${scopeNames.length ? scopeNames.join(", ") : "(none)"}`,
  ].join("\n");
}

function parseCurrentEntityPath(
  path: string,
  handle: string,
): { nodeType: NodeTypeName; id: string } | null {
  const clean = path.split("?")[0] ?? "";
  const parts = clean.split("/").filter(Boolean);
  if (parts[0] !== handle) return null;
  if (parts[1] === "scopes" && parts[2]) return { nodeType: "scope", id: parts[2] };
  const nodeType = parts[1];
  const id = parts[2];
  if (!nodeType || !id || !CHAT_NODE_TYPES.has(nodeType as NodeTypeName)) return null;
  return { nodeType: nodeType as NodeTypeName, id };
}

async function callOpenAI(apiKey: string, messages: OpenAIChatMessage[]): Promise<OpenAIResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as OpenAIResponse;
  } finally {
    clearTimeout(timeout);
  }
}

function parseFastPathCommand(
  rawMessage: string,
  attachments: ChatAttachment[] | undefined,
  docos: DocoChatDocoContext[],
  currentHandle: string,
): FastPathToolCall | null {
  if (attachments?.length) return null;
  const message = rawMessage.trim().replace(/\s+/g, " ");
  if (!message) return null;
  const mentionedHandle = findMentionedDocoHandle(message, docos);
  const mentionsOtherDoco = !!mentionedHandle && mentionedHandle !== currentHandle;
  return (
    parseFastStatusQuestion(message, mentionedHandle) ??
    (mentionsOtherDoco
      ? null
      : (parseFastCreateNode(message) ??
        parseFastLifecycleChange(message) ??
        parseFastAddEdge(message)))
  );
}

function parseFastStatusQuestion(
  message: string,
  mentionedHandle: string | null,
): FastPathToolCall | null {
  const lower = message.toLowerCase();
  const asksForCount = /\b(how many|count|counts|total|number of)\b/.test(lower);
  if (!asksForCount) return null;
  const targetText = mentionedHandle ? lower.replaceAll(mentionedHandle.toLowerCase(), "") : lower;
  const target = inferCountTarget(targetText) ?? (mentionedHandle ? "nodes" : null);
  if (!target) return null;
  return {
    tool: "get_status",
    args: {
      node_type: target,
      ...(mentionedHandle ? { doco_handle: mentionedHandle } : {}),
    },
  };
}

function findMentionedDocoHandle(message: string, docos: DocoChatDocoContext[]): string | null {
  const lower = message.toLowerCase();
  const handles = docos.map((doco) => doco.handle).sort((a, b) => b.length - a.length);
  return handles.find((handle) => lower.includes(handle.toLowerCase())) ?? null;
}

function parseFastCreateNode(message: string): FastPathToolCall | null {
  const scopedPrefix = message.match(
    /^(?:create|add)\s+(?:a\s+|an\s+)?(decision|intent|action|log|rule|reference)(?:\s+node)?\s+((?:#[\w-]+[\s,]*)+)\s*:\s*(.+)$/i,
  );
  const plain = message.match(
    /^(?:create|add)\s+(?:a\s+|an\s+)?(decision|intent|action|log|rule|reference)(?:\s+node)?(?:\s+(?:called|named))?\s+(.+?)(?:\s+(?:in|under)\s+((?:#[\w-]+[\s,]*)+))\.?$/i,
  );
  const match = scopedPrefix ?? plain;
  if (!match) return null;
  const nodeType = match[1]?.toLowerCase();
  if (!nodeType || !CAPTURE_NODE_TYPES.has(nodeType)) return null;
  const summary = cleanFastPathText(scopedPrefix ? match[3] : match[2]);
  const scopeText = scopedPrefix ? match[2] : match[3];
  const scopeNames = parseFastPathScopes(scopeText);
  if (!summary || scopeNames.length === 0) return null;
  return {
    tool: "create_node",
    args: {
      node_type: nodeType,
      summary,
      scope_names: scopeNames,
    },
  };
}

function parseFastLifecycleChange(message: string): FastPathToolCall | null {
  const nodeIdPattern = "(decision|intent|action|log|rule|reference)_[0-9A-Z]+";
  const patterns = [
    new RegExp(
      `^(?:set|change)\\s+(?:the\\s+)?lifecycle\\s+(?:of|for)\\s+(${nodeIdPattern})\\s+(?:to|as)\\s+([a-z_ -]+)\\.?$`,
      "i",
    ),
    new RegExp(
      `^(?:set|change)\\s+(${nodeIdPattern})\\s+(?:lifecycle\\s+)?(?:to|as)\\s+([a-z_ -]+)\\.?$`,
      "i",
    ),
    new RegExp(`^mark\\s+(${nodeIdPattern})\\s+([a-z_ -]+)\\.?$`, "i"),
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) continue;
    const target_id = match[1];
    const lifecycle = normalizeLifecycle(match[3] ?? match[2]);
    if (!target_id || !lifecycle || !LIFECYCLES.has(lifecycle)) continue;
    return {
      tool: "change_lifecycle",
      args: { target_id, lifecycle },
    };
  }
  return null;
}

function parseFastAddEdge(message: string): FastPathToolCall | null {
  const match = message.match(
    /^(?:add|create)\s+(?:a\s+|an\s+)?(serves|enacts|follows|born_from|superseded_by|tests|in_scope_of)(?:\s+edge)?\s+from\s+([\w_]+)\s+to\s+([\w_#-]+)\.?$/i,
  );
  if (!match) return null;
  const edge_type = match[1]?.toLowerCase();
  const from_id = match[2];
  const to_id = match[3];
  if (!edge_type || !from_id || !to_id) return null;
  return {
    tool: "add_edge",
    args: { from_id, to_id, edge_type },
  };
}

function fastPathReply(outcome: DocoChatOperation): string {
  if (outcome.applied) {
    if (outcome.tool === "get_status" || outcome.tool === "find_nodes") return outcome.description;
    const suffix = outcome.navigate_to ? " I am showing it now." : "";
    return `Done: ${outcome.description}.${suffix}`;
  }
  return `I could not apply that directly: ${outcome.error ?? "unknown error"}`;
}

function isMutatingTool(tool: string): boolean {
  return tool !== "find_nodes" && tool !== "get_status";
}

function parseFastPathScopes(raw: string | undefined): string[] {
  if (!raw) return [];
  const matches = raw.match(/#[\w-]+/g) ?? [];
  return Array.from(new Set(matches.map(normalizeScopeName)));
}

function cleanFastPathText(raw: string | undefined): string {
  return String(raw ?? "")
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, "")
    .trim();
}

function normalizeLifecycle(raw: string | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_");
}

function inferCountTarget(lowerMessage: string): string | null {
  if (/\b(edge|edges)\b/.test(lowerMessage)) return "edges";
  for (const { key, nodeType } of COUNT_TABLES) {
    const plural = key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const singular = nodeType.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    if (new RegExp(`\\b(${singular}|${plural})\\b`).test(lowerMessage)) return key;
  }
  if (/\b(node|nodes|doco|graph)\b/.test(lowerMessage)) return "nodes";
  return null;
}

function singularLabel(plural: string): string {
  const found = COUNT_TABLES.find((t) => t.key === plural);
  return found?.nodeType ?? plural.replace(/s$/, "");
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to empty args.
  }
  return {};
}

async function applyToolCall(opts: {
  tool: string;
  args: Record<string, unknown>;
  input: RunDocoChatTurnInput;
  docos: DocoChatDocoContext[];
}): Promise<DocoChatOperation> {
  const { tool, args, input, docos } = opts;
  switch (tool) {
    case "get_status":
      return getStatus(input, args, docos);
    case "find_nodes":
      return findNodes(input, args, docos);
    case "create_node":
      return createNode(input, args, docos);
    case "change_lifecycle":
      return changeLifecycle(input, args, docos);
    case "add_edge":
      return addEdge(input, args, docos);
    default:
      return { tool, description: `Unknown tool: ${tool}`, applied: false, error: "Unknown tool." };
  }
}

function resolveToolDoco(
  input: RunDocoChatTurnInput,
  args: Record<string, unknown>,
  docos: DocoChatDocoContext[],
): ToolTarget | { ok: false; operation: DocoChatOperation } {
  const requestedHandle = stringArg(args.doco_handle);
  const handle = requestedHandle || input.handle;
  const doco = docos.find((candidate) => candidate.handle === handle);
  if (doco) return { ok: true, doco };
  return {
    ok: false,
    operation: {
      tool: "resolve_doco",
      description: `Resolve Doco ${handle}`,
      applied: false,
      error: requestedHandle
        ? `I do not have access to a Doco with handle "${requestedHandle}".`
        : "No current Doco context is available.",
    },
  };
}

async function getStatus(
  input: RunDocoChatTurnInput,
  args: Record<string, unknown>,
  docos: DocoChatDocoContext[],
): Promise<DocoChatOperation> {
  const targetResult = resolveToolDoco(input, args, docos);
  if (!targetResult.ok) return { ...targetResult.operation, tool: "get_status" };
  const targetDoco = targetResult.doco;
  const rawTarget = typeof args.node_type === "string" ? args.node_type : "nodes";
  const target = COUNT_TARGETS.get(rawTarget.toLowerCase()) ?? "nodes";
  const counts = await loadDocoCounts(targetDoco.docoId);
  const label = targetDoco.handle === input.handle ? "This Doco" : targetDoco.handle;
  if (target === "edges") {
    return {
      tool: "get_status",
      description: `${label} has ${formatCount(counts.edges, "edge")}.`,
      applied: true,
    };
  }
  if (target !== "nodes") {
    return {
      tool: "get_status",
      description: `${label} has ${formatCount(counts.byType[target] ?? 0, singularLabel(target))}.`,
      applied: true,
    };
  }
  const byType = COUNT_TABLES.map(({ key }) => `${key}: ${counts.byType[key] ?? 0}`).join(", ");
  return {
    tool: "get_status",
    description: `${label} has ${formatCount(counts.nodes, "node")} and ${formatCount(counts.edges, "edge")}. By type: ${byType}.`,
    applied: true,
  };
}

async function loadDocoCounts(docoId: string): Promise<{
  nodes: number;
  edges: number;
  byType: Record<string, number>;
}> {
  return withClient(async (c) => {
    const byType: Record<string, number> = {};
    const countResults = await Promise.all(
      COUNT_TABLES.map(async ({ key, table }) => {
        const result = await c.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM ${table} WHERE doco_id = $1`,
          [docoId],
        );
        return [key, Number(result.rows[0]?.n ?? 0)] as const;
      }),
    );
    for (const [key, n] of countResults) byType[key] = n;
    const edgesResult = await c.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM edges WHERE doco_id = $1",
      [docoId],
    );
    return {
      nodes: Object.values(byType).reduce((sum, n) => sum + n, 0),
      edges: Number(edgesResult.rows[0]?.n ?? 0),
      byType,
    };
  });
}

async function findNodes(
  input: RunDocoChatTurnInput,
  args: Record<string, unknown>,
  docos: DocoChatDocoContext[],
): Promise<DocoChatOperation> {
  const targetResult = resolveToolDoco(input, args, docos);
  if (!targetResult.ok) return { ...targetResult.operation, tool: "find_nodes" };
  const targetDoco = targetResult.doco;
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const requestedType = typeof args.node_type === "string" ? args.node_type : "any";
  if (!query) {
    return { tool: "find_nodes", description: "Search skipped — empty query", applied: false };
  }
  const types = requestedType === "any" ? Object.keys(ENTITY_TABLE) : [requestedType];
  const rows = await withClient(async (c) => {
    const out: {
      id: string;
      node_type: string;
      label: string | null;
      lifecycle: string | null;
    }[] = [];
    for (const t of types) {
      const table = ENTITY_TABLE[t];
      if (!table) continue;
      const labelExpr = t === "scope" ? "COALESCE(purpose, name)" : "summary";
      const result = await c.query<{
        id: string;
        node_type: string;
        label: string | null;
        lifecycle: string | null;
      }>(
        `SELECT id, $3::text AS node_type, ${labelExpr} AS label, lifecycle
           FROM ${table}
          WHERE doco_id = $1
            AND (id = $2 OR ${labelExpr} ILIKE '%' || $2 || '%')
          ORDER BY updated_at DESC
          LIMIT 6`,
        [targetDoco.docoId, query, t],
      );
      out.push(...result.rows);
    }
    return out.slice(0, 8);
  });
  const description = rows.length
    ? rows
        .map((r) => `${r.id} (${r.node_type}, ${r.lifecycle ?? "no lifecycle"}): ${r.label}`)
        .join("\n")
    : `No nodes found in ${targetDoco.handle} for "${query}".`;
  return { tool: "find_nodes", description, applied: true };
}

async function createNode(
  input: RunDocoChatTurnInput,
  args: Record<string, unknown>,
  docos: DocoChatDocoContext[],
): Promise<DocoChatOperation> {
  const targetResult = resolveToolDoco(input, args, docos);
  if (!targetResult.ok) return { ...targetResult.operation, tool: "create_node" };
  const targetDoco = targetResult.doco;
  const nodeType = typeof args.node_type === "string" ? args.node_type : "";
  if (!CAPTURE_NODE_TYPES.has(nodeType)) {
    return {
      tool: "create_node",
      description: "Create node",
      applied: false,
      error: "Unsupported node type.",
    };
  }
  const summary = stringArg(args.summary);
  const scopeNames = arrayOfStrings(args.scope_names).map(normalizeScopeName);
  if (!summary || scopeNames.length === 0) {
    return {
      tool: "create_node",
      description: `Create ${nodeType}`,
      applied: false,
      error: "summary and scope_names are required.",
    };
  }
  const gate = await enforceScopeRoleGate({
    meta: targetDoco.meta,
    docoDir: targetDoco.docoDir,
    scopeNames,
    principalId: input.actor.id,
    mutatesLifecycle: false,
  });
  if (!gate.ok) {
    return {
      tool: "create_node",
      description: `Create ${nodeType}`,
      applied: false,
      error: gate.error,
    };
  }
  const lifecycle = gate.shouldForceProposed ? "proposed" : stringArg(args.lifecycle);
  const body_md = stringArg(args.body_md);
  let result: CaptureResult | CaptureError;
  if (nodeType === "decision") {
    const draft: DecisionDraft = {
      summary,
      question: stringArg(args.question) || summary,
      chosen: stringArg(args.chosen) || summary,
      scope_names: scopeNames,
      decided_by_username: input.actor.username,
      created_by_id: input.actor.id,
      ...(body_md ? { body_md } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    };
    result = await captureDecision(
      targetDoco.docoDir,
      targetDoco.docoId,
      targetDoco.ownerSlug,
      targetDoco.docoSlug,
      draft,
      input.docoHost,
    );
  } else if (nodeType === "intent") {
    const draft: IntentDraft = {
      summary,
      scope_names: scopeNames,
      wanted_by_username: input.actor.username,
      ...(body_md ? { body_md } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    };
    result = await captureIntent(
      targetDoco.docoDir,
      targetDoco.docoId,
      targetDoco.ownerSlug,
      targetDoco.docoSlug,
      draft,
      input.docoHost,
    );
  } else if (nodeType === "action") {
    const draft: ActionDraft = {
      summary,
      scope_names: scopeNames,
      verb: stringArg(args.verb) || "updated",
      performed_by_username: input.actor.username,
      created_by_id: input.actor.id,
      ...(body_md ? { body_md } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    };
    result = await captureAction(
      targetDoco.docoDir,
      targetDoco.docoId,
      targetDoco.ownerSlug,
      targetDoco.docoSlug,
      draft,
      input.docoHost,
    );
  } else if (nodeType === "log") {
    const draft: LogDraft = {
      summary,
      scope_names: scopeNames,
      verb: stringArg(args.verb) || "recorded",
      happened_at: stringArg(args.happened_at) || new Date().toISOString(),
      outputs: objectArg(args.outputs) ?? { note: summary },
      performed_by_username: input.actor.username,
      created_by_id: input.actor.id,
      ...(body_md ? { body_md } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    };
    result = await captureLog(
      targetDoco.docoDir,
      targetDoco.docoId,
      targetDoco.ownerSlug,
      targetDoco.docoSlug,
      draft,
      input.docoHost,
    );
  } else if (nodeType === "rule") {
    const draft: RuleDraft = {
      summary,
      scope_names: scopeNames,
      predicate: stringArg(args.predicate) || summary,
      authored_by_username: input.actor.username,
      created_by_id: input.actor.id,
      ...(body_md ? { body_md } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    };
    result = await captureRule(
      targetDoco.docoDir,
      targetDoco.docoId,
      targetDoco.ownerSlug,
      targetDoco.docoSlug,
      draft,
      input.docoHost,
    );
  } else {
    const draft: ReferenceDraft = {
      summary,
      scope_names: scopeNames,
      ref_type: stringArg(args.ref_type) || "other",
      locator: stringArg(args.locator) || summary,
      created_by_username: input.actor.username,
      created_by_id: input.actor.id,
      ...(body_md ? { body_md } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    };
    result = await captureReference(
      targetDoco.docoDir,
      targetDoco.docoId,
      targetDoco.ownerSlug,
      targetDoco.docoSlug,
      draft,
      input.docoHost,
    );
  }
  return operationFromCapture(
    targetDoco,
    "create_node",
    `Create ${nodeType}: ${summary}`,
    nodeType as NodeTypeName,
    result,
  );
}

async function changeLifecycle(
  input: RunDocoChatTurnInput,
  args: Record<string, unknown>,
  docos: DocoChatDocoContext[],
): Promise<DocoChatOperation> {
  const targetResult = resolveToolDoco(input, args, docos);
  if (!targetResult.ok) return { ...targetResult.operation, tool: "change_lifecycle" };
  const targetDoco = targetResult.doco;
  const targetId = stringArg(args.target_id);
  const lifecycle = stringArg(args.lifecycle);
  if (!targetId || !lifecycle) {
    return {
      tool: "change_lifecycle",
      description: "Change lifecycle",
      applied: false,
      error: "target_id and lifecycle are required.",
    };
  }
  if (!LIFECYCLES.has(lifecycle)) {
    return {
      tool: "change_lifecycle",
      description: `Change lifecycle → ${lifecycle}`,
      applied: false,
      error: `Unsupported lifecycle: ${lifecycle}`,
    };
  }
  const nodeType = nodeTypeFromId(targetId);
  if (!nodeType) {
    return {
      tool: "change_lifecycle",
      description: targetId,
      applied: false,
      error: "Unsupported target id.",
    };
  }
  const canPatch = await ensureCanPatchEntity(input, targetDoco, targetId, nodeType, true);
  if (!canPatch.ok) {
    return {
      tool: "change_lifecycle",
      description: `Change lifecycle → ${lifecycle}`,
      applied: false,
      error: canPatch.error,
    };
  }
  const result =
    nodeType === "decision"
      ? await updateDecision(
          targetDoco.docoDir,
          targetDoco.docoId,
          targetDoco.ownerSlug,
          targetDoco.docoSlug,
          targetId,
          { lifecycle },
          input.docoHost,
          input.actor.id,
        )
      : await updateEntity({
          docoDir: targetDoco.docoDir,
          docoId: targetDoco.docoId,
          ownerSlug: targetDoco.ownerSlug,
          docoSlug: targetDoco.docoSlug,
          nodeType,
          pluralDir: PLURAL_DIR[nodeType],
          id: targetId,
          patch: { lifecycle },
          allowedFields: [],
          docoHost: input.docoHost,
          actorId: input.actor.id,
        });
  return operationFromCapture(
    targetDoco,
    "change_lifecycle",
    `Change ${targetId} lifecycle → ${lifecycle}`,
    nodeType,
    result,
  );
}

async function addEdge(
  input: RunDocoChatTurnInput,
  args: Record<string, unknown>,
  docos: DocoChatDocoContext[],
): Promise<DocoChatOperation> {
  const targetResult = resolveToolDoco(input, args, docos);
  if (!targetResult.ok) return { ...targetResult.operation, tool: "add_edge" };
  const targetDoco = targetResult.doco;
  const fromId = stringArg(args.from_id);
  const toId = stringArg(args.to_id);
  const edgeType = stringArg(args.edge_type);
  if (!fromId || !toId || !edgeType) {
    return {
      tool: "add_edge",
      description: "Add edge",
      applied: false,
      error: "from_id, to_id, and edge_type are required.",
    };
  }
  const fromType = nodeTypeFromId(fromId);
  if (!fromType) {
    return {
      tool: "add_edge",
      description: `Add ${edgeType}`,
      applied: false,
      error: "Unsupported source node type.",
    };
  }
  const canPatch = await ensureCanPatchEntity(input, targetDoco, fromId, fromType, false);
  if (!canPatch.ok) {
    return {
      tool: "add_edge",
      description: `Add ${edgeType}`,
      applied: false,
      error: canPatch.error,
    };
  }
  const patchResult = await edgePatch(targetDoco, fromId, fromType, toId, edgeType);
  if (!patchResult.ok) {
    return {
      tool: "add_edge",
      description: `Add ${edgeType}`,
      applied: false,
      error: patchResult.error,
    };
  }
  if (edgeType === "in_scope_of") {
    const gate = await enforceScopeRoleGate({
      meta: targetDoco.meta,
      docoDir: targetDoco.docoDir,
      scopeNames: [patchResult.scopeName],
      principalId: input.actor.id,
      mutatesLifecycle: false,
    });
    if (!gate.ok) {
      return {
        tool: "add_edge",
        description: `Add ${edgeType}`,
        applied: false,
        error: gate.error,
      };
    }
  }
  const result =
    fromType === "decision"
      ? await updateDecision(
          targetDoco.docoDir,
          targetDoco.docoId,
          targetDoco.ownerSlug,
          targetDoco.docoSlug,
          fromId,
          patchResult.patch,
          input.docoHost,
          input.actor.id,
        )
      : await updateEntity({
          docoDir: targetDoco.docoDir,
          docoId: targetDoco.docoId,
          ownerSlug: targetDoco.ownerSlug,
          docoSlug: targetDoco.docoSlug,
          nodeType: fromType,
          pluralDir: PLURAL_DIR[fromType],
          id: fromId,
          patch: patchResult.patch,
          allowedFields: patchResult.allowedFields,
          docoHost: input.docoHost,
          actorId: input.actor.id,
        });
  return operationFromCapture(
    targetDoco,
    "add_edge",
    `Add ${edgeType}: ${fromId} → ${toId}`,
    fromType,
    result,
  );
}

function operationFromCapture(
  targetDoco: DocoChatDocoContext,
  tool: string,
  description: string,
  nodeType: NodeTypeName,
  result: CaptureResult | CaptureError,
): DocoChatOperation {
  if ("error" in result) return { tool, description, applied: false, error: result.error };
  const navigate_to = entityUrl({ docoId: targetDoco.handle, nodeType, id: result.id });
  return {
    tool,
    description,
    applied: true,
    footer_lines: result.footer_lines,
    navigate_to,
  };
}

async function ensureCanPatchEntity(
  input: RunDocoChatTurnInput,
  targetDoco: DocoChatDocoContext,
  id: string,
  nodeType: NodeTypeName,
  mutatesLifecycle: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await getEntity(nodeType, id);
  if (!existing || existing.doco_id !== targetDoco.docoId) {
    return { ok: false, error: `${nodeType} not found: ${id}` };
  }
  const fm = parseRecord(existing.raw_yaml);
  const scopeIds = Array.isArray(fm.scopes)
    ? fm.scopes.filter((s): s is string => typeof s === "string")
    : [];
  const scopeNames = await loadScopeNamesByIds(scopeIds);
  if (scopeNames.length > 0) {
    const gate = await enforceScopeRoleGate({
      meta: targetDoco.meta,
      docoDir: targetDoco.docoDir,
      scopeNames,
      principalId: input.actor.id,
      mutatesLifecycle,
    });
    if (!gate.ok) return { ok: false, error: gate.error };
    return { ok: true };
  }
  const role = await getDocoLevelRole(
    { ownerId: targetDoco.meta.ownerId, docoId: targetDoco.meta.docoId },
    input.actor.id,
  );
  if (!role || !roleAtLeast(role, "author"))
    return { ok: false, error: "Forbidden: author role required." };
  if (mutatesLifecycle && !roleAtLeast(role, "approver")) {
    return { ok: false, error: "Forbidden: approver role required to change lifecycle." };
  }
  return { ok: true };
}

async function edgePatch(
  targetDoco: DocoChatDocoContext,
  fromId: string,
  fromType: NodeTypeName,
  toId: string,
  edgeType: string,
): Promise<
  | { ok: true; patch: EntityPatch; allowedFields: string[]; scopeName: string }
  | { ok: false; error: string }
> {
  if (edgeType === "in_scope_of") {
    if (!toId.startsWith("scope_"))
      return { ok: false, error: "in_scope_of edges must target a scope." };
    const names = await loadScopeNamesByIds([toId]);
    const scopeName = names[0];
    if (!scopeName) return { ok: false, error: `Scope not found: ${toId}` };
    return { ok: true, patch: { scope_names_add: [scopeName] }, allowedFields: [], scopeName };
  }
  const targetType = toId.split("_")[0] ?? "";
  const rec = await getEntity(fromType, fromId);
  if (!rec || rec.doco_id !== targetDoco.docoId)
    return { ok: false, error: `${fromType} not found: ${fromId}` };
  const targetNodeType = nodeTypeFromId(toId);
  if (targetNodeType) {
    const target = await getEntity(targetNodeType, toId).catch(() => null);
    if (!target || target.doco_id !== targetDoco.docoId) {
      return { ok: false, error: `Target not found in ${targetDoco.handle}: ${toId}` };
    }
  }
  const fm = parseRecord(rec.raw_yaml);
  if (edgeType === "serves") {
    if (targetType !== "intent") return { ok: false, error: "serves edges must target an Intent." };
    return {
      ok: true,
      patch: { intent_ids_add: [toId] },
      allowedFields: [],
      scopeName: "",
    };
  }
  if (edgeType === "enacts") {
    if (targetType !== "decision")
      return { ok: false, error: "enacts edges must target a Decision." };
    return listFieldPatch(fm, "decision_ids", toId);
  }
  if (edgeType === "follows") return listFieldPatch(fm, "follows", toId);
  if (edgeType === "born_from") return scalarFieldPatch("born_from", toId);
  if (edgeType === "superseded_by") return scalarFieldPatch("superseded_by", toId);
  if (edgeType === "tests") return scalarFieldPatch("target_ref", toId);
  return { ok: false, error: `Unsupported edge type: ${edgeType}` };
}

function listFieldPatch(
  fm: Record<string, unknown>,
  field: string,
  toId: string,
): { ok: true; patch: EntityPatch; allowedFields: string[]; scopeName: string } {
  const existing = Array.isArray(fm[field])
    ? (fm[field] as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const next = existing.includes(toId) ? existing : [...existing, toId];
  return {
    ok: true,
    patch: { [field]: next },
    allowedFields: [field],
    scopeName: "",
  };
}

function scalarFieldPatch(
  field: string,
  toId: string,
): { ok: true; patch: EntityPatch; allowedFields: string[]; scopeName: string } {
  return { ok: true, patch: { [field]: toId }, allowedFields: [field], scopeName: "" };
}

function nodeTypeFromId(id: string): NodeTypeName | null {
  const prefix = id.split("_")[0];
  if (!prefix || !CHAT_NODE_TYPES.has(prefix as NodeTypeName)) return null;
  return prefix as NodeTypeName;
}

function parseRecord(rawYaml: string | null | undefined): Record<string, unknown> {
  if (!rawYaml) return {};
  try {
    const parsed = parseYaml(rawYaml);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectArg(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function normalizeScopeName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

const TEXT_READABLE_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
  "application/sql",
]);
const INLINED_TEXT_CHAR_CAP = 50_000;

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function isTextReadableMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  return TEXT_READABLE_MIMES.has(mime);
}

function decodeDataUrlAsText(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return "";
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (!header.includes(";base64")) {
    try {
      return decodeURIComponent(body);
    } catch {
      return "";
    }
  }
  try {
    return Buffer.from(body, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function buildCurrentUserMessage(
  message: string,
  attachments: ChatAttachment[] | undefined,
): OpenAIChatMessage {
  if (!attachments || attachments.length === 0) return { role: "user", content: message };
  const parts: OpenAIContentPart[] = [{ type: "text", text: message || "(no message text)" }];
  for (const att of attachments) {
    if (isImageMime(att.mime)) {
      parts.push({ type: "image_url", image_url: { url: att.dataUrl } });
      parts.push({
        type: "text",
        text: `[image above: ${att.name} · ${att.mime} · ${att.size} bytes]`,
      });
      continue;
    }
    if (isTextReadableMime(att.mime)) {
      const text = decodeDataUrlAsText(att.dataUrl);
      const truncated = text.length > INLINED_TEXT_CHAR_CAP;
      parts.push({
        type: "text",
        text: `[attached file: ${att.name} · ${att.mime} · ${att.size} bytes${truncated ? " · TRUNCATED" : ""}]\n${text.slice(0, INLINED_TEXT_CHAR_CAP)}`,
      });
      continue;
    }
    parts.push({
      type: "text",
      text: `[attached file: ${att.name} · ${att.mime} · ${att.size} bytes — not readable by the assistant; acknowledge but do not invent contents]`,
    });
  }
  return { role: "user", content: parts };
}
