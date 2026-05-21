// In-page assistant — server side.
//
// One rolling conversation per signed-in Principal. The sidebar reopens
// to the most recently touched thread; "New chat" archives the current
// row and starts fresh. Messages are persisted as Anthropic-shaped
// content blocks so a turn that included tool_use / tool_result blocks
// can be re-fed to the model verbatim on the next turn.
//
// The agent acts on behalf of the signed-in user: tool calls relay
// through the user's session cookie, so the agent's read + write
// surface is exactly the user's. There is no separate principal, no
// OAuth dance — "same level of access as the user" is realized
// literally by reusing the same credential.
//
// Two tools:
//   - doco_api({method, path, body}): fetch a Doco endpoint as the user
//   - navigate({url}): push a URL to the client (SPA navigation, no
//     full reload)
//
// The conversation system prompt is bootstrapped much like the agent-
// bootstrap endpoint feeds external agents — the canonical protocol
// prose + the union of org + Doco constitutions the user can read —
// but reframed for an in-page sidebar (no two-line connection header,
// no footer-lines / tally lines).

import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type {
  ContentBlockParam,
  MessageParam,
  TextBlock,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { listOrganizationsForPrincipal, withClient } from "@doco/db";
import { generateUlid } from "@doco/shared";
import { canAccessDoco } from "./doco-access.server";
import { ensureEnvLoaded } from "./dotenv.server";
import { listAllDocos } from "./host";
import type { CurrentPrincipal } from "./session";

ensureEnvLoaded();

// Haiku 4.5 over Sonnet — for an in-page assistant, sub-second first-
// token latency beats the marginal reasoning gain. Snappy capture +
// navigate flows matter more than careful prose. Bump to Sonnet here
// if tool-routing accuracy regresses.
const MODEL = "claude-haiku-4-5";
const MAX_TURNS_PER_REPLY = 12;
const MAX_TOKENS = 2048;

// Anthropic's typed content blocks coming back from the API arrive as
// concrete shapes (no "param" suffix). When we feed them back as part
// of the next message they need to look like message-param blocks.
// In practice the JSON is identical for our two block types so we just
// stash the API shape and treat them as `ContentBlockParam`.
type StoredAssistantBlock = TextBlock | ToolUseBlock;

export interface ChatConversationRow {
  id: string;
  principal_id: string;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: ContentBlockParam[];
  created_at: Date;
}

export interface ChatStreamContext {
  origin: string;
  cookieHeader: string;
  principal: CurrentPrincipal;
  currentPath: string | null;
}

export type ChatStreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_use_start"; tool_use_id: string; name: string }
  | { kind: "tool_use_input"; tool_use_id: string; input: unknown }
  | { kind: "tool_use_result"; tool_use_id: string; ok: boolean; preview: string }
  | { kind: "navigate"; url: string }
  | { kind: "message_saved"; message_id: string; role: "user" | "assistant" }
  | { kind: "done" }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * One conversation per principal, forever. Returns the principal's
 * row if it exists, otherwise mints one. There is no archive / new-
 * chat affordance — the thread is the user's single rolling memory.
 * The `archived` column on the table is legacy from an earlier
 * design; left in place because dropping it would require a migration
 * and the dead column is harmless.
 */
export async function loadOrCreateConversation(
  principalId: string,
): Promise<ChatConversationRow> {
  return await withClient(async (c) => {
    const existing = await c.query<ChatConversationRow>(
      `SELECT id, principal_id, archived, created_at, updated_at
         FROM chat_conversations
        WHERE principal_id = $1
        ORDER BY created_at ASC
        LIMIT 1`,
      [principalId],
    );
    if (existing.rows[0]) return existing.rows[0];
    const id = `conv_${generateUlid()}`;
    const fresh = await c.query<ChatConversationRow>(
      `INSERT INTO chat_conversations (id, principal_id)
       VALUES ($1, $2)
       RETURNING id, principal_id, archived, created_at, updated_at`,
      [id, principalId],
    );
    const row = fresh.rows[0];
    if (!row) throw new Error("failed to create conversation row");
    return row;
  });
}

export async function loadMessages(conversationId: string): Promise<ChatMessageRow[]> {
  return await withClient(async (c) => {
    const r = await c.query<ChatMessageRow>(
      `SELECT id, conversation_id, role, content, created_at
         FROM chat_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC`,
      [conversationId],
    );
    return r.rows;
  });
}

async function appendMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: ContentBlockParam[],
): Promise<ChatMessageRow> {
  return await withClient(async (c) => {
    const id = `msg_${generateUlid()}`;
    const r = await c.query<ChatMessageRow>(
      `INSERT INTO chat_messages (id, conversation_id, role, content)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, conversation_id, role, content, created_at`,
      [id, conversationId, role, JSON.stringify(content)],
    );
    await c.query(`UPDATE chat_conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
    const row = r.rows[0];
    if (!row) throw new Error("failed to append chat message");
    return row;
  });
}

// ---------------------------------------------------------------------------
// System-prompt bootstrap
// ---------------------------------------------------------------------------

interface BootstrapContext {
  docoLines: string[];
  orgLines: string[];
  constitutionSnippets: string[];
}

async function buildBootstrapContext(principalId: string): Promise<BootstrapContext> {
  const [allDocos, orgs] = await Promise.all([
    listAllDocos(),
    listOrganizationsForPrincipal(principalId),
  ]);
  const docoLines: string[] = [];
  const orgLines: string[] = orgs.map((o) => `- /orgs/${o.slug} (${o.name})`);
  const constitutionSnippets: string[] = [];

  for (const d of allDocos) {
    const meta = { ownerId: d.ownerId, visibility: d.visibility, docoId: d.docoId };
    if (!(await canAccessDoco(meta, principalId))) continue;
    docoLines.push(`- /${d.handle} (visibility ${d.visibility})`);
    const articles = await withClient(async (c) => {
      const [guidance, authoring] = await Promise.all([
        c.query<{ summary: string }>(
          `SELECT summary FROM guidance_articles
            WHERE doco_id = $1 AND COALESCE(lifecycle,'active') = 'active'
            ORDER BY created_at DESC LIMIT 5`,
          [d.docoId],
        ),
        c.query<{ summary: string }>(
          `SELECT summary FROM node_authoring_articles
            WHERE doco_id = $1 AND COALESCE(lifecycle,'active') = 'active'
            ORDER BY created_at DESC LIMIT 5`,
          [d.docoId],
        ),
      ]);
      return { guidance: guidance.rows, authoring: authoring.rows };
    });
    if (articles.guidance.length || articles.authoring.length) {
      const lines = [`Constitution for /${d.handle}:`];
      for (const a of articles.guidance) lines.push(`  - guidance: ${a.summary}`);
      for (const a of articles.authoring) lines.push(`  - rule: ${a.summary}`);
      constitutionSnippets.push(lines.join("\n"));
    }
  }
  return { docoLines, orgLines, constitutionSnippets };
}

/**
 * Build the system prompt as a two-block array so Anthropic can cache
 * the large, stable prefix (identity + endpoint surface + constitutions)
 * across turns. The dynamic tail (today + current page) goes in the
 * user message instead — that keeps every cache key identical.
 */
function buildSystemBlocks(
  principal: CurrentPrincipal,
  bootstrap: BootstrapContext,
): TextBlockParam[] {
  const docoList = bootstrap.docoLines.length
    ? bootstrap.docoLines.join("\n")
    : "(none yet — the user can create one at /new-doco)";
  const orgList = bootstrap.orgLines.length
    ? bootstrap.orgLines.join("\n")
    : "(no orgs — the user can create one at /new-org)";
  const constitutions = bootstrap.constitutionSnippets.length
    ? bootstrap.constitutionSnippets.join("\n\n")
    : "(no constitution articles authored in the visible Docos)";

  const text = `You are Doco's in-page assistant, embedded as a 280-px left-rail sidebar on every page. You act AS ${principal.username} — the signed-in human reading the page. Every doco_api call is authenticated as them; there is no separate agent identity.

Doco is AI-native documentation of intent, decisions, rules, actions, logs. Node types: Decision, Intent, Action, Log, Rule, Guidance Article, Node Authoring Article, Eval, Reference, State, Idea.

## Tools

- doco_api({method, path, body?}): HTTP request to the Doco host with the user's session. Path starts with /. Returns {status, ok, body}.
- navigate({url}): SPA-navigate the user's browser. No full reload. Use after captures, when the user asks to be taken somewhere, or when a dedicated page would answer their question better than prose.

## Endpoint surface

  GET   /<handle>/status.json
  GET   /<handle>/api/<type>.json                — list (type ∈ decisions, intents, actions, rules, logs, evals, references, guidance_articles, node_authoring_articles, ideas, states, principals, invites, audit)
  POST  /<handle>/api/<type>.json                — capture; returns { id, footer_lines, duration_ms }
  GET   /<handle>/api/<type>/<id>.json
  PATCH /<handle>/api/<type>/<id>.json
  GET   /<handle>/search.json?q=<query>
  POST  /api/v1/docos.json                       — create a Doco (NO GET — to list the user's Docos, see the "Your Docos" section below)
  POST  /api/v1/orgs.json                        — create an Org (NO GET — to list the user's Orgs, see the "Your Orgs" section below)
  GET   /api/v1/agent-bootstrap.json             — re-read constitutions

## After every action — render the result

When the user asks you to DO something concrete, you must end the turn on a page that visibly proves it happened. Default destinations:

| Action | Navigate to |
|---|---|
| Captured a new node | /<handle>/<type>/<id> — entity-detail page with mini graph |
| Added/changed an edge (patched a ref field on a node) | /<handle>/<type>/<from-id> — source node's graph neighborhood now shows the edge |
| Browsing edges in general | /<handle>/edges (list) or /<handle>/edges/<edge-key> (detail with two-node graph) |
| Created a new Doco / Org | /<new-handle> |
| User asked "show me X" | the page that lists or details X |

After the navigate, end the text reply with at most ONE short line (e.g. "Decision captured — see graph." or just "✓"). Never paste the URL — the navigate already moved them there.

## Adding an edge

Edges in Doco are derived from reference fields on nodes (D-017, fields-as-edges). To add an edge from A to B with type T, PATCH the source node A to add B's id into the appropriate ref field. Map (mostly): intent_ids → serves · decision_ids → enacts · rules_consulted → consults · born_from → born_from · superseded_by → superseded_by · target_ref → tests · stakeholders → has_stakeholder · parent_intent_id → has_parent · owner_id → owned_by · member → member_of · follows → follows. There is no POST /<handle>/api/edges.json — patch a node's ref field; the indexer materializes the edge synchronously.

## Speed rules

1. Tool first, words second. When the user gives a direct command ("add a decision about X", "take me to Y"), START with the tool call. No preamble, no restating, no clarifying questions you can avoid.
2. One tool round-trip per user-visible step. Don't list before capturing if the user already gave you the content.
3. Keep replies under 2 short lines unless the user asked for explanation.
4. Don't await confirmation between capture and navigate — chain them.

## Other working principles

- Be terse. The sidebar is narrow.
- Read before you write only when you genuinely don't know enough to write a good node. Otherwise, write.
- Deduplicate. Before a new node, scan for one already covering the territory; patch beats create.
- Honor the constitution. Articles below govern your captures.

## Your Docos and Orgs — canonical

The two lists below are computed server-side at the start of each turn from the same access-control checks ${principal.username} sees in the UI. They are COMPLETE and AUTHORITATIVE — every Doco / Org the user can read or write is here. When asked "how many Docos do I have?" or "what's my org?", answer from these lists directly. Never hedge with "if there are others not visible…" — there aren't. Don't probe with HTTP GETs to discover Docos/Orgs; there is no listing endpoint for those.

### Your Docos

${docoList}

### Your Orgs

${orgList}

## Constitution articles that govern node authoring

${constitutions}`;

  return [
    {
      type: "text",
      text,
      // Mark the entire system block as ephemerally cacheable. Anthropic
      // keys on byte-identical prefixes, so subsequent turns within ~5 min
      // hit the cache and skip re-processing this ~2-4 KB prompt.
      cache_control: { type: "ephemeral" },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "doco_api",
    description:
      "Make an HTTP request to the Doco host as the signed-in user. Returns the response body (JSON parsed when possible, otherwise text), plus the HTTP status.",
    input_schema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PATCH", "DELETE"],
          description: "HTTP method.",
        },
        path: {
          type: "string",
          description:
            "Relative path starting with /. E.g. '/myhandle/api/decisions.json' or '/api/v1/docos.json'.",
        },
        body: {
          description:
            "JSON body. Required for POST/PATCH on capture endpoints; omit for GET. Pass an object — the tool stringifies it.",
        },
      },
      required: ["method", "path"],
    },
  },
  {
    name: "navigate",
    description:
      "Push the user's browser to a Doco URL. Causes a client-side navigation (no page reload, no sidebar reset). Use when the user asks to be taken somewhere, or when the destination page would be the natural place to continue the conversation.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Relative path starting with /, e.g. '/myhandle/decisions'.",
        },
      },
      required: ["url"],
    },
  },
];

interface ToolResult {
  result: ToolResultBlockParam;
  navigateUrl?: string;
  preview: string;
  ok: boolean;
}

async function runTool(
  block: ToolUseBlock,
  ctx: ChatStreamContext,
): Promise<ToolResult> {
  if (block.name === "navigate") {
    const input = block.input as { url?: unknown };
    const url = typeof input?.url === "string" ? input.url : "";
    if (!url.startsWith("/")) {
      return {
        result: {
          type: "tool_result",
          tool_use_id: block.id,
          content: `error: navigate url must start with "/" (got: ${JSON.stringify(url)})`,
          is_error: true,
        },
        preview: `navigate(${JSON.stringify(url)}) — refused (must start with /)`,
        ok: false,
      };
    }
    return {
      result: {
        type: "tool_result",
        tool_use_id: block.id,
        content: `navigated to ${url}`,
      },
      navigateUrl: url,
      preview: `navigate → ${url}`,
      ok: true,
    };
  }
  if (block.name === "doco_api") {
    const input = block.input as { method?: unknown; path?: unknown; body?: unknown };
    const method = typeof input?.method === "string" ? input.method.toUpperCase() : "GET";
    const path = typeof input?.path === "string" ? input.path : "";
    if (!path.startsWith("/")) {
      return {
        result: {
          type: "tool_result",
          tool_use_id: block.id,
          content: `error: path must start with "/" (got: ${JSON.stringify(path)})`,
          is_error: true,
        },
        preview: `${method} ${path} — refused (path must start with /)`,
        ok: false,
      };
    }
    const url = new URL(path, ctx.origin).toString();
    try {
      const init: RequestInit = {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Cookie: ctx.cookieHeader,
          "User-Agent": "Doco-In-Page-Assistant/1",
        },
      };
      if (method !== "GET" && method !== "DELETE" && input?.body !== undefined) {
        init.body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON — pass through as text
      }
      const ok = res.ok;
      const body = {
        status: res.status,
        ok,
        body: parsed,
      };
      const previewBody =
        typeof parsed === "string"
          ? parsed.slice(0, 100)
          : JSON.stringify(parsed).slice(0, 100);
      return {
        result: {
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(body),
          is_error: !ok,
        },
        preview: `${method} ${path} → ${res.status} ${previewBody}`,
        ok,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        result: {
          type: "tool_result",
          tool_use_id: block.id,
          content: `fetch failed: ${msg}`,
          is_error: true,
        },
        preview: `${method} ${path} — fetch failed: ${msg}`,
        ok: false,
      };
    }
  }
  return {
    result: {
      type: "tool_result",
      tool_use_id: block.id,
      content: `unknown tool: ${block.name}`,
      is_error: true,
    },
    preview: `unknown tool: ${block.name}`,
    ok: false,
  };
}

// ---------------------------------------------------------------------------
// Streaming turn
// ---------------------------------------------------------------------------

function rowsToHistory(rows: ChatMessageRow[]): MessageParam[] {
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

export async function* runAssistantTurn(args: {
  conversation: ChatConversationRow;
  userText: string;
  ctx: ChatStreamContext;
}): AsyncGenerator<ChatStreamEvent> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    yield {
      kind: "error",
      message:
        "ANTHROPIC_API_KEY is not configured on the server. Add it to .env to enable the in-page assistant.",
    };
    return;
  }

  const client = new Anthropic({ apiKey });
  const history = await loadMessages(args.conversation.id);
  const messages: MessageParam[] = rowsToHistory(history);

  // Per-turn dynamic context lives in the user message so the system
  // prompt stays byte-identical across turns (cache-friendly).
  const todayIso = new Date().toISOString().slice(0, 10);
  const pageLine = args.ctx.currentPath ? `Page: ${args.ctx.currentPath}` : "Page: (unknown)";
  const turnHeader = `[Today ${todayIso}. ${pageLine}.]\n\n`;
  const userContent: ContentBlockParam[] = [
    { type: "text", text: `${turnHeader}${args.userText}` },
  ];
  // Persist the user's words alone — the dynamic header is metadata for
  // the model, not part of the human's history.
  const persistedUserContent: ContentBlockParam[] = [{ type: "text", text: args.userText }];
  const userRow = await appendMessage(args.conversation.id, "user", persistedUserContent);
  messages.push({ role: "user", content: userContent });
  yield { kind: "message_saved", message_id: userRow.id, role: "user" };

  const bootstrap = await buildBootstrapContext(args.ctx.principal.id);
  const systemBlocks = buildSystemBlocks(args.ctx.principal, bootstrap);

  for (let turn = 0; turn < MAX_TURNS_PER_REPLY; turn++) {
    const stream: MessageStream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemBlocks,
      tools: TOOLS,
      messages,
    });

    const collectedBlocks: StoredAssistantBlock[] = [];
    let activeToolUse: { id: string; name: string; partialJson: string } | null = null;

    try {
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            activeToolUse = {
              id: event.content_block.id,
              name: event.content_block.name,
              partialJson: "",
            };
            yield {
              kind: "tool_use_start",
              tool_use_id: event.content_block.id,
              name: event.content_block.name,
            };
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { kind: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta" && activeToolUse) {
            activeToolUse.partialJson += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          activeToolUse = null;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { kind: "error", message: `Anthropic stream error: ${msg}` };
      return;
    }

    const finalMessage = await stream.finalMessage();
    for (const block of finalMessage.content) {
      if (block.type === "text" || block.type === "tool_use") {
        collectedBlocks.push(block);
      }
    }

    // Emit assembled input for each tool_use block (so the UI can show
    // what the model is about to do before we run the tool).
    for (const block of collectedBlocks) {
      if (block.type === "tool_use") {
        yield { kind: "tool_use_input", tool_use_id: block.id, input: block.input };
      }
    }

    messages.push({ role: "assistant", content: collectedBlocks as ContentBlockParam[] });

    if (finalMessage.stop_reason !== "tool_use") {
      // Save assistant turn (text-only) and finish.
      const saved = await appendMessage(
        args.conversation.id,
        "assistant",
        collectedBlocks as ContentBlockParam[],
      );
      yield { kind: "message_saved", message_id: saved.id, role: "assistant" };
      yield { kind: "done" };
      return;
    }

    // Tool use turn — run each tool, append a single user-role message
    // containing all the tool_result blocks (Anthropic API contract).
    const toolUseBlocks = collectedBlocks.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const tr = await runTool(block, args.ctx);
      yield {
        kind: "tool_use_result",
        tool_use_id: block.id,
        ok: tr.ok,
        preview: tr.preview,
      };
      if (tr.navigateUrl) {
        yield { kind: "navigate", url: tr.navigateUrl };
      }
      toolResults.push(tr.result);
    }

    // Persist the assistant turn AND the tool-result user message so
    // the next reload reproduces the same context.
    const assistantSaved = await appendMessage(
      args.conversation.id,
      "assistant",
      collectedBlocks as ContentBlockParam[],
    );
    yield { kind: "message_saved", message_id: assistantSaved.id, role: "assistant" };

    const toolResultContent: ContentBlockParam[] = toolResults;
    const toolMsgSaved = await appendMessage(
      args.conversation.id,
      "user",
      toolResultContent,
    );
    messages.push({ role: "user", content: toolResultContent });
    yield { kind: "message_saved", message_id: toolMsgSaved.id, role: "user" };
  }

  yield {
    kind: "error",
    message: `Hit MAX_TURNS_PER_REPLY=${MAX_TURNS_PER_REPLY} without completing — stopping to avoid a tool-call loop.`,
  };
}

// ---------------------------------------------------------------------------
// Public read API for the loader
// ---------------------------------------------------------------------------

export interface ConversationSnapshot {
  conversation_id: string;
  messages: { id: string; role: "user" | "assistant"; content: ContentBlockParam[]; created_at: string }[];
}

export async function loadSnapshotForPrincipal(principalId: string): Promise<ConversationSnapshot> {
  const conv = await loadOrCreateConversation(principalId);
  const rows = await loadMessages(conv.id);
  return {
    conversation_id: conv.id,
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      created_at: r.created_at.toISOString(),
    })),
  };
}
