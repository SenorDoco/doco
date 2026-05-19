// Per-node chat backend. The node detail view ships an AI chat panel on the
// left that lets the project owner describe a change in plain English; this
// module routes that prose to OpenAI with tool-use, applies the chosen tool
// against the existing capture helpers, and returns the assistant's reply
// plus a list of operations that actually fired.
//
// Tools are intentionally narrow — `update_summary`, `append_to_body`,
// `add_scope`, `remove_scope`, `change_lifecycle`. They all map to fields
// the underlying capture helpers (`updateDecision`, `updateEntity`) already
// accept, so the per-type validation gates fire as usual.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import {
  type DecisionPatch,
  type EntityPatch,
  type NodeTypeName,
  updateDecision,
  updateEntity,
} from "./capture.server";

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

export interface ChatOperation {
  /** Tool name the LLM picked. */
  tool: string;
  /** One-line human-readable description of what was attempted. */
  description: string;
  /** Whether the underlying capture helper accepted the change. */
  applied: boolean;
  /** Error string when applied = false. */
  error?: string;
}

export interface RunChatTurnInput {
  docoDir: string;
  docoId: string;
  ownerSlug: string;
  docoSlug: string;
  nodeType: NodeTypeName;
  pluralDir: string;
  id: string;
  /** Node context the LLM gets: summary, body_md, scopes, lifecycle. */
  context: NodeContextSnapshot;
  /** Free-form user message. */
  message: string;
  /** Prior turns in the same browser session. Caller appends locally. */
  history: ChatTurn[];
  /** Origin URL for the doco host (for capture helper bookkeeping). */
  docoHost: string;
  actorId: string | null;
}

export interface NodeContextSnapshot {
  summary: string | null;
  body_md: string | null;
  lifecycle: string | null;
  scope_names: string[];
  /** Scope names available in this Doco — the LLM picks from this list. */
  available_scope_names: string[];
}

export interface RunChatTurnResult {
  reply: string;
  operations: ChatOperation[];
  /**
   * True if any tool successfully fired — the caller should revalidate the
   * route data so the graph + header reflect the new state.
   */
  mutated: boolean;
}

const SYSTEM_PROMPT = `You are an AI editor for one node in a Doco-tracked project.

The user is looking at this node's detail page and wants to change something about it. Use the available tools to apply changes. Each tool call mutates the node via Doco's capture helpers; results return immediately.

Rules:
- Be concise. Confirm what you changed in one or two sentences.
- Prefer the smallest, most targeted edit that satisfies the request. Don't rewrite the whole body when a summary tweak is enough.
- For \`update_summary\`, keep the new summary short and declarative (1 sentence).
- For \`append_to_body\`, write a clearly delimited paragraph starting with an "Update YYYY-MM-DD:" prefix so the audit trail stays readable.
- For \`add_scope\` / \`remove_scope\`, scope names must come from the available list and always start with "#".
- For \`change_lifecycle\`, valid values are: active, proposed, planned, retired, abandoned, superseded.
- If the user asks something you can't do with the available tools (e.g. delete the node, create a new node), say so plainly — don't invent a tool call.
- If the request is ambiguous, ask one short clarifying question instead of guessing.`;

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "update_summary",
      description: "Replace the node's one-line summary.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "New one-sentence summary." },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "append_to_body",
      description:
        "Append a paragraph to the node's body. Used for adding context, an update note, or a follow-up rationale.",
      parameters: {
        type: "object",
        properties: {
          markdown: {
            type: "string",
            description:
              "Markdown to append. Start with 'Update YYYY-MM-DD:' so the audit trail reads cleanly.",
          },
        },
        required: ["markdown"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "add_scope",
      description: "Tag this node with an existing scope (by name).",
      parameters: {
        type: "object",
        properties: {
          scope_name: {
            type: "string",
            description: "Scope name including the leading '#'. Must exist in this Doco.",
          },
        },
        required: ["scope_name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remove_scope",
      description: "Untag this node from a scope.",
      parameters: {
        type: "object",
        properties: {
          scope_name: {
            type: "string",
            description: "Scope name including the leading '#'.",
          },
        },
        required: ["scope_name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "change_lifecycle",
      description: "Change the node's lifecycle stage.",
      parameters: {
        type: "object",
        properties: {
          lifecycle: {
            type: "string",
            enum: ["active", "proposed", "planned", "retired", "abandoned", "superseded"],
            description: "New lifecycle value.",
          },
        },
        required: ["lifecycle"],
        additionalProperties: false,
      },
    },
  },
];

const MAX_TOOL_ROUNDS = 4;

export async function runChatTurn(input: RunChatTurnInput): Promise<RunChatTurnResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      reply:
        "OPENAI_API_KEY is missing on the host, so the chat assistant is offline. Set it in `./.env` (web package) and retry.",
      operations: [],
      mutated: false,
    };
  }

  const messages: OpenAIChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: nodeContextBlock(input.nodeType, input.id, input.context) },
    ...input.history.map<OpenAIChatMessage>((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    { role: "user", content: input.message },
  ];

  const operations: ChatOperation[] = [];
  let mutated = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await callOpenAI(apiKey, messages);
    const choice = completion.choices?.[0]?.message;
    if (!choice) {
      return {
        reply: "(empty response from OpenAI)",
        operations,
        mutated,
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
      };
    }

    for (const call of choice.tool_calls) {
      const args = parseToolArgs(call.function.arguments);
      const outcome = await applyToolCall({
        tool: call.function.name,
        args,
        input,
      });
      operations.push(outcome);
      if (outcome.applied) mutated = true;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify({
          applied: outcome.applied,
          error: outcome.error ?? null,
          description: outcome.description,
        }),
      });
    }
  }

  return {
    reply:
      "Reached the maximum number of tool-use rounds. Some changes may have applied; check the operation list and refresh the page.",
    operations,
    mutated,
  };
}

function nodeContextBlock(nodeType: NodeTypeName, id: string, ctx: NodeContextSnapshot): string {
  return [
    `You are editing a ${nodeType} node.`,
    `id: ${id}`,
    `summary: ${ctx.summary ?? "(none)"}`,
    `lifecycle: ${ctx.lifecycle ?? "(none)"}`,
    `scopes: ${ctx.scope_names.length ? ctx.scope_names.join(", ") : "(none)"}`,
    `available_scopes_in_this_doco: ${ctx.available_scope_names.join(", ")}`,
    "",
    "body_md:",
    "```",
    ctx.body_md ?? "(empty)",
    "```",
  ].join("\n");
}

interface OpenAIResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }[];
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
  input: RunChatTurnInput;
}): Promise<ChatOperation> {
  const { tool, args, input } = opts;
  switch (tool) {
    case "update_summary": {
      const summary = typeof args.summary === "string" ? args.summary.trim() : "";
      if (!summary) {
        return {
          tool,
          description: "update_summary (empty)",
          applied: false,
          error: "Empty summary.",
        };
      }
      return applyPatch({
        input,
        description: `Update summary → "${summary.slice(0, 60)}${summary.length > 60 ? "…" : ""}"`,
        tool,
        patch: { summary },
      });
    }
    case "append_to_body": {
      const markdown = typeof args.markdown === "string" ? args.markdown : "";
      if (!markdown.trim()) {
        return {
          tool,
          description: "append_to_body (empty)",
          applied: false,
          error: "Empty markdown.",
        };
      }
      if (input.nodeType === "scope" || input.nodeType === "reference") {
        return {
          tool,
          description: `append_to_body skipped — ${input.nodeType} has no body field.`,
          applied: false,
          error: `Body append is not supported for ${input.nodeType}.`,
        };
      }
      return applyPatch({
        input,
        description: `Append paragraph (${markdown.trim().length} chars) to body`,
        tool,
        patch: { body_md_append: markdown },
      });
    }
    case "add_scope": {
      const scopeName = normalizeScopeName(args.scope_name);
      if (!scopeName) {
        return {
          tool,
          description: "add_scope (missing name)",
          applied: false,
          error: "Missing scope name.",
        };
      }
      if (!input.context.available_scope_names.includes(scopeName)) {
        return {
          tool,
          description: `add_scope ${scopeName} — not in this Doco`,
          applied: false,
          error: `Scope ${scopeName} doesn't exist in this Doco. Create it first.`,
        };
      }
      return applyPatch({
        input,
        description: `Add scope ${scopeName}`,
        tool,
        patch: { scope_names_add: [scopeName] },
      });
    }
    case "remove_scope": {
      const scopeName = normalizeScopeName(args.scope_name);
      if (!scopeName) {
        return {
          tool,
          description: "remove_scope (missing name)",
          applied: false,
          error: "Missing scope name.",
        };
      }
      return applyPatch({
        input,
        description: `Remove scope ${scopeName}`,
        tool,
        patch: { scope_names_remove: [scopeName] },
      });
    }
    case "change_lifecycle": {
      const lifecycle = typeof args.lifecycle === "string" ? args.lifecycle.trim() : "";
      if (!lifecycle) {
        return {
          tool,
          description: "change_lifecycle (missing value)",
          applied: false,
          error: "Missing lifecycle value.",
        };
      }
      return applyPatch({
        input,
        description: `Change lifecycle → ${lifecycle}`,
        tool,
        patch: { lifecycle },
      });
    }
    default:
      return { tool, description: `Unknown tool: ${tool}`, applied: false, error: "Unknown tool." };
  }
}

function normalizeScopeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

async function applyPatch(opts: {
  input: RunChatTurnInput;
  description: string;
  tool: string;
  patch: EntityPatch;
}): Promise<ChatOperation> {
  const { input, description, tool, patch } = opts;
  try {
    const result =
      input.nodeType === "decision"
        ? await updateDecision(
            input.docoDir,
            input.docoId,
            input.ownerSlug,
            input.docoSlug,
            input.id,
            patch as DecisionPatch,
            input.docoHost,
            input.actorId,
          )
        : await updateEntity({
            docoDir: input.docoDir,
            docoId: input.docoId,
            ownerSlug: input.ownerSlug,
            docoSlug: input.docoSlug,
            nodeType: input.nodeType,
            pluralDir: input.pluralDir,
            id: input.id,
            patch,
            allowedFields: [],
            docoHost: input.docoHost,
            actorId: input.actorId,
          });
    if ("error" in result) {
      return { tool, description, applied: false, error: result.error };
    }
    return { tool, description, applied: true };
  } catch (e) {
    return { tool, description, applied: false, error: (e as Error).message };
  }
}
